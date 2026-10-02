"""Defense-in-depth redaction. Isolation, not pattern matching, protects credentials.

Never load real secrets into this module to populate a denylist. Public token and
wallet addresses (20 bytes) remain usable. Suspected credentials stop publication.
"""
import base64
import binascii
import ipaddress
import re
import unicodedata
import urllib.parse

PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
    re.compile(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9+/=_\-.]{12,}"),
    re.compile(r"\b(?:sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gb_api_[A-Za-z0-9]{16,})\b"),
    re.compile(r"(?i)(?<![a-z0-9])(?:0x)?[a-f0-9]{64}(?![a-z0-9])"),
    re.compile(r"(?i)\b(?:private[_ -]?key|api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|seed[_ -]?phrase|mnemonic)[\"']?\s*[=:]\s*[^\r\n,;}]{6,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)([?&](?:pass|password|token|secret|key|signature)=)[^\s&#\"']+"),
    re.compile(r"(?i)https?://[^\s/:]+:[^\s/@]+@[^\s/]+"),
]
CONTROL = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
INVISIBLE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")
IPV4 = re.compile(r"(?<![\w.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?!\w|\.\w)")
IPV6 = re.compile(r"(?<![\w:])(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9:.]*(?:%[\w.-]+)?(?![\w:])")
ENCODED_TOKEN = re.compile(r"(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{24,8192}={0,2}(?![A-Za-z0-9_+/=-])")
ESCAPED_CHARACTER = re.compile(r"\\+(?:u([a-fA-F0-9]{4})|x([a-fA-F0-9]{2}))")


def normalized(value):
    # Reject common invisible/full-width evasion. This is deliberately not a
    # decoder for arbitrary encoded secrets; isolation remains the boundary.
    return INVISIBLE.sub("", unicodedata.normalize("NFKC", str(value)))


def redact_ip(match):
    raw = match.group(0)
    # IPv6 candidates permit dots for embedded IPv4. Do not let prose's final
    # period invalidate an otherwise literal IP. Keep punctuation in the output.
    candidate = raw.rstrip(".")
    try:
        ipaddress.ip_address(candidate)
        return "[REDACTED_IP]" + raw[len(candidate):]
    except ValueError:
        return raw


def redact_ips(text):
    # IPv6 first so mapped IPv4 (e.g. ::ffff:192.0.2.4) is removed as one literal,
    # not partially transformed before the IPv6 validator can recognize it.
    return IPV4.sub(redact_ip, IPV6.sub(redact_ip, text))


def private_text(text):
    return any(pattern.search(text) for pattern in PATTERNS) or redact_ips(text) != text


def encoded_private(text, depth=0):
    """Recognize bounded common wrappers, not arbitrary secret encodings.

    Decode only for inspection. Never forward decoded data, execute it or exempt
    opaque strings. Credential isolation remains the primary boundary.
    """
    if depth >= 2:
        return False
    shadows = []
    if "%" in text:
        try: shadows.append(urllib.parse.unquote(text, errors="strict"))
        except UnicodeError: pass
    if "\\" in text:
        shadows.append(ESCAPED_CHARACTER.sub(lambda m: chr(int(m.group(1) or m.group(2), 16)), text))
    for match in ENCODED_TOKEN.finditer(text):
        token = match.group(0)
        try:
            decoded = base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True).decode("utf-8")
            shadows.append(decoded)
        except (binascii.Error, UnicodeError, ValueError): pass
        if len(token) % 2 == 0 and re.fullmatch(r"[a-fA-F0-9]+", token):
            try: shadows.append(bytes.fromhex(token).decode("utf-8"))
            except UnicodeError: pass
    for shadow in shadows:
        shadow = normalized(shadow)
        if shadow != text and (private_text(shadow) or encoded_private(shadow, depth + 1)):
            return True
    return False


def redact(value):
    text = normalized(value)
    if encoded_private(text):
        return "[REDACTED_ENCODED_DATA]"
    for pattern in PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return CONTROL.sub("", redact_ips(text))


def require_public(value):
    text = normalized(value)
    if private_text(text) or encoded_private(text):
        raise ValueError("suspected credential or infrastructure IP: do not put private values in messages, files or publications")
    if INVISIBLE.search(str(value)) or CONTROL.search(str(value)):
        raise ValueError("hidden or terminal-control characters are not allowed")
    return str(value)
