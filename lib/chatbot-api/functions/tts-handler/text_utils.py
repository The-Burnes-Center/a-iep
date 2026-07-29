"""
Pure text helpers for the TTS handler: markdown -> speakable plain text,
and chunking long text at natural boundaries for providers with per-request
character limits.
"""
import re

# Sentence boundaries: latin/arabic punctuation followed by whitespace, or CJK
# full-width punctuation (which is not followed by a space in zh text).
_SENTENCE_END = re.compile(r'(?<=[.!?؟])\s+|(?<=[。！？])')


def markdown_to_text(md: str) -> str:
    """
    Convert markdown (as stored in content.json) to plain speakable text.
    Keeps paragraph breaks (they become natural pauses in synthesized speech).
    """
    if not md:
        return ''
    text = md

    # Code blocks and inline code
    text = re.sub(r'```[\s\S]*?```', ' ', text)
    text = re.sub(r'`([^`]*)`', r'\1', text)

    # Images dropped entirely; links keep their label
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)

    # Residual HTML tags
    text = re.sub(r'<[^>]+>', ' ', text)

    # Headers and blockquotes
    text = re.sub(r'^\s{0,3}#{1,6}\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s{0,3}>\s?', '', text, flags=re.MULTILINE)

    # Horizontal rules (before emphasis so *** isn't half-eaten)
    text = re.sub(r'^\s{0,3}([-*_]\s?){3,}\s*$', '', text, flags=re.MULTILINE)

    # Bold / italic markers
    text = re.sub(r'(\*\*|__)(.*?)\1', r'\2', text)
    text = re.sub(r'(\*|_)(.*?)\1', r'\2', text)

    # Tables: drop separator rows, turn cell pipes into sentence breaks
    text = re.sub(r'^\s*\|?[\s:|-]+\|[\s:|-]*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\|\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*\|\s*$', '', text, flags=re.MULTILINE)
    text = text.replace('|', '. ')

    # List markers (bullets and numbered)
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\d+[.)]\s+', '', text, flags=re.MULTILINE)

    # Collapse horizontal whitespace, cap consecutive blank lines at one
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def chunk_text(text: str, max_chars: int) -> list:
    """
    Split text into chunks of at most max_chars, preferring paragraph
    boundaries, then sentence boundaries, then a hard split as a last resort.
    """
    if len(text) <= max_chars:
        return [text] if text else []

    chunks = []
    current = ''
    for para in text.split('\n\n'):
        pieces = [para] if len(para) <= max_chars else _split_sentences(para, max_chars)
        for piece in pieces:
            if not piece:
                continue
            if current and len(current) + len(piece) + 2 > max_chars:
                chunks.append(current)
                current = piece
            else:
                current = f'{current}\n\n{piece}' if current else piece
    if current:
        chunks.append(current)
    return chunks


def _split_sentences(para: str, max_chars: int) -> list:
    pieces = []
    current = ''
    for sentence in _SENTENCE_END.split(para):
        # Hard-split any single sentence that alone exceeds the limit
        while len(sentence) > max_chars:
            if current:
                pieces.append(current)
                current = ''
            pieces.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        if not sentence:
            continue
        if current and len(current) + len(sentence) + 1 > max_chars:
            pieces.append(current)
            current = sentence
        else:
            current = f'{current} {sentence}' if current else sentence
    if current:
        pieces.append(current)
    return pieces
