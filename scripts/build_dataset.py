#!/usr/bin/env python3
"""
Build Supabase seed SQL directly from a policy PDF using OpenAI embeddings.

Usage:
  python scripts/build_dataset.py \
    --pdf 2014.pdf \
    --title "2014년 치과 보험 청구 지침" \
    --source "2014.pdf" \
    --output supabase/seed/2014_chunks.sql

Environment:
  OPENAI_API_KEY must be set so the generated embeddings match the runtime model.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from textwrap import dedent
from typing import Iterable, List, Sequence, Tuple

import requests
from pypdf import PdfReader

EMBED_MODEL = "text-embedding-3-small"
DIM = 1536


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate chunk embeddings from a PDF.")
    parser.add_argument("--pdf", required=True, help="Path to the source PDF.")
    parser.add_argument("--title", required=True, help="Human-readable document title.")
    parser.add_argument("--source", required=True, help="Source identifier (e.g. filename).")
    parser.add_argument("--output", required=True, help="Destination SQL file.")
    parser.add_argument("--max-chars", type=int, default=1100, help="Maximum characters per chunk.")
    parser.add_argument("--min-chars", type=int, default=200, help="Minimum characters per chunk.")
    parser.add_argument("--max-chunks", type=int, default=120, help="Maximum chunks to generate.")
    return parser.parse_args()


def extract_paragraphs(pdf_path: Path) -> List[str]:
    reader = PdfReader(str(pdf_path))
    paragraphs: List[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        text = text.replace("\u00a0", " ")
        blocks = re.split(r"\n\s*\n", text)
        for block in blocks:
            normalized = " ".join(line.strip() for line in block.splitlines())
            normalized = re.sub(r"\s+", " ", normalized).strip()
            if not normalized:
                continue
            if len(normalized) < 25 and not re.match(r"^[0-9IVX]+\.", normalized):
                # Skip tiny headings unless they look like section markers.
                continue
            paragraphs.append(normalized)
    return paragraphs


def chunk_paragraphs(
    paragraphs: Sequence[str],
    max_chars: int,
    min_chars: int,
    max_chunks: int,
) -> List[str]:
    chunks: List[str] = []
    buffer: List[str] = []
    buffer_len = 0
    for paragraph in paragraphs:
        if buffer and buffer_len + len(paragraph) + 1 > max_chars:
            chunk = " ".join(buffer).strip()
            if len(chunk) >= min_chars:
                chunks.append(chunk)
            buffer = []
            buffer_len = 0
            if len(chunks) >= max_chunks:
                break
        buffer.append(paragraph)
        buffer_len += len(paragraph) + 1
    if buffer and len(chunks) < max_chunks:
        chunk = " ".join(buffer).strip()
        if len(chunk) >= min_chars:
            chunks.append(chunk)
    return chunks[:max_chunks]


def fetch_embedding(text: str, api_key: str) -> List[float]:
    response = requests.post(
        "https://api.openai.com/v1/embeddings",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "input": text,
            "model": EMBED_MODEL,
        },
        timeout=60,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"OpenAI embeddings failed {response.status_code}: {response.text}",
        )
    payload = response.json()
    embedding = payload["data"][0]["embedding"]
    if len(embedding) != DIM:
        raise ValueError(f"Expected embedding dim {DIM}, got {len(embedding)}")
    return embedding


def sql_escape(value: str) -> str:
    return value.replace("'", "''")


def format_vector(values: Sequence[float]) -> str:
    return "[" + ", ".join(f"{v:.8f}" for v in values) + "]"


def build_sql(title: str, source: str, chunks: Sequence[Tuple[str, Sequence[float]]]) -> str:
    value_rows = []
    for index, (content, embedding) in enumerate(chunks):
        value_rows.append(
            f"({index}, '{sql_escape(content)}', '{format_vector(embedding)}'::vector({DIM}))",
        )
    values_sql = ",\n      ".join(value_rows)
    return dedent(
        f"""
        -- Seed generated with OpenAI embeddings from {sql_escape(source)}
        truncate table insurance_chunks restart identity cascade;
        truncate table insurance_docs restart identity cascade;

        with doc as (
          insert into insurance_docs (title, source)
          values ('{sql_escape(title)}', '{sql_escape(source)}')
          returning id
        )
        insert into insurance_chunks (doc_id, chunk_index, content, embedding)
        select doc.id, payload.chunk_index, payload.content, payload.embedding
        from doc,
        lateral (values
          {values_sql}
        ) as payload(chunk_index, content, embedding);
        """,
    ).strip() + "\n"


def main() -> None:
    args = parse_args()
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required to generate embeddings.")

    paragraphs = extract_paragraphs(pdf_path)
    if not paragraphs:
        raise SystemExit("No text extracted from PDF.")

    chunks = chunk_paragraphs(paragraphs, args.max_chars, args.min_chars, args.max_chunks)
    if not chunks:
        raise SystemExit("Chunking produced no output.")

    dataset: List[Tuple[str, List[float]]] = []
    for idx, chunk in enumerate(chunks):
        print(f"Embedding chunk {idx + 1}/{len(chunks)} (len={len(chunk)})...")
        embedding = fetch_embedding(chunk, api_key)
        dataset.append((chunk, embedding))

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sql = build_sql(args.title, args.source, dataset)
    output_path.write_text(sql, encoding="utf-8")
    print(f"Wrote {len(dataset)} chunks to {output_path}")


if __name__ == "__main__":
    main()
