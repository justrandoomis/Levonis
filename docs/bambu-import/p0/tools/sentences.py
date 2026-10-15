"""Port of the step-4 sentence classifier (packages/catalog/src/bambuImport/sentences.ts, spec §C.10) and of the payload's
customer-text refusal (payload.ts REFUSED_FOR / textRefusal). P0 uses it to find, before the run, every source string that is
copied verbatim into a customer-text payload field (title, option group name, option value name) and that the validator would
refuse with IMPORT_PAYLOAD_KEY_REFUSED (refused_text) — a BLOCKED item at its turn. Hits are reported by id and class only,
never as text (§C.10: "Hits never reach the logs as text, only as counts").

Kept in step with sentences.ts in the step-4 working tree (/home/user/levonis-import, HEAD 7a482e6b plus the uncommitted
review-4 widening of three lists: price claims, bundle savings and gifts, store order / stock / purchase-limit terms).
tools/verify.py compares this port with the real TypeScript classifier run over the same corpus (work/step4/check.ts ->
work/step4/check.json, which records the step-4 code state it ran against): the hits must be equal.
"""
import re

_I = re.I
MONEY = [
    re.compile(r'(?:US)?\$\s?\d', _I),
    re.compile(r'\$\s?\[redacted\]', _I),  # the fixtures' scrubbed amounts
    re.compile(r'\d[\d,.]*\s*(?:USD|US dollars?|dollars?)\b', _I),
    re.compile(r'\bUSD\s?\d', _I),
    re.compile(r'\bprice\b[^.!?]{0,40}\d', _I),
    re.compile(r'\bprice[\s-](?:protection|match(?:ing)?|adjustment|drop|guarantee)\b', _I),
    re.compile(r'\b(?:typical|original|regular|list|compare[- ]at)\s+price\b', _I),
    # Price claims: the source's price is not ours to praise.
    re.compile(r'\b(?:great|unbeatable|incredible|competitive|reasonable|affordable|amazing|unmatched|attractive|excellent|best|low|lower|fair)\s+pric(?:e|es|ing)\b', _I),
    re.compile(r'\b(?:less|lower|reduced)\s+(?:cost|price)\b', _I),
    re.compile(r'\bgreat value\b', _I),
    re.compile(r'\bvalue for (?:the )?money\b', _I),
    re.compile(r'\bbang for (?:the|your) buck\b', _I),
]
PROMOTION = [
    re.compile(r'\bdiscount(?:s|ed)?\b', _I),
    re.compile(r'\bcoupons?\b', _I),
    re.compile(r'\bdeals?\b', _I),
    re.compile(r'\bfree shipping\b', _I),
    re.compile(r'\bon sale\b', _I),
    re.compile(r'\bsale price\b', _I),
    re.compile(r'\blimited[\s-]time\b', _I),
    re.compile(r'\bsave\s+(?:on|up\s+to|\$|\d)', _I),
    re.compile(r'\d+\s*%\s*off\b', _I),
    re.compile(r'\boff\s+(?:US)?\$\s?\d', _I),
    re.compile(r'\bbuy\s+(?:one|\d+)\s+get\b', _I),
    re.compile(r'\bflash sale\b', _I),
    re.compile(r'\bpromo(?:tion|tional)?\s+code\b', _I),
    re.compile(r'\bexclusive (?:offer|price)\b', _I),
    # Bundle savings and gifts.
    re.compile(r'\bsave more\b', _I),
    re.compile(r'\d+\s*%\s*savings?\b', _I),
    re.compile(r'\bsavings?\b[^.!?]*\b(?:bundle|individual(?:ly)?|separately|compared to buying)\b', _I),
    re.compile(r'\b(?:bundle|kit|combo)\b[^.!?]*\bsavings\b', _I),
    re.compile(r'\badd-?ons?\b[^.!?]{0,20}\bsave\b', _I),
    re.compile('\U0001F381'),  # the gift emoji
    re.compile(r'(?:^|[:;]\s*)[\s"\'“(*•-]*free\s+(?!-)(?:\w+\s+){0,3}(?:gift|sock|socks|panel|accessor(?:y|ies)|item|items|tool|kit|'
               r'sample|samples|upgrade|replacement|spool|bonus)\b', _I),
    re.compile(r'\bfree gifts?\b', _I),
    re.compile(r'\bgifts? with (?:purchase|every|each)\b', _I),
]
SHIPPING_POLICY = [
    re.compile(r'\bshipping costs?\b', _I),
    re.compile(r'\bships? within\b', _I),
    re.compile(r'\bdelivery times?\b', _I),
    re.compile(r'\bpackaging may vary\b', _I),
    re.compile(r'\borders? placed\b', _I),
    re.compile(r'\breturn shipping\b', _I),
    re.compile(r'\bshipping (?:fee|policy|rates?)\b', _I),
    re.compile(r'\bdispatched within\b', _I),
    # The store's own order and packing terms.
    re.compile(r'\b(?:your|my) orders?\b', _I),
    re.compile(r'\bplac(?:e|ed|ing) (?:an|your|the) orders?\b', _I),
    re.compile(r'\bshipped\b[^.!?]{0,40}\b(?:separate|packag(?:e|es|ing))\b', _I),
    re.compile(r'\bstandard shipping\b', _I),
    re.compile(r'\bdivided into (?:\w+\s+)?packages\b', _I),
    # Stock and purchase limits.
    re.compile(r'\blimited stock\b', _I),
    re.compile(r'\bwhile (?:supplies|stocks?) last\b', _I),
    re.compile(r'\brestock(?:ed|ing|s)?\b', _I),
    re.compile(r'\bsold[\s-]out\b', _I),
    re.compile(r'\bin stock\b', _I),
    re.compile(r'\bout of stock\b', _I),
    re.compile(r'\bpurchase (?:quantity|limit)\b', _I),
    re.compile(r'\bper (?:user|customer|account|household)\b', _I),
    re.compile(r'\bunits? per (?:user|order|customer|account|household)\b', _I),
]
WARRANTY = [
    re.compile(r'\bwarrant(?:y|ies)\b', _I),
    re.compile(r'\b(?:money[\s-]back|satisfaction)\s+guarantee\b', _I),
    re.compile(r'\bguarantee\s+(?:period|policy|card|terms|coverage)\b', _I),
    re.compile(r'\b\d+[\s-](?:year|month|day)s?\s+guarantee\b', _I),
    re.compile(r'\b\d+[\s-]day\s+returns?\b', _I),
    re.compile(r'\breturns?\b[^.!?]{0,40}\b(?:policy|period|window|within|accepted|eligible|label|request)\b', _I),
    re.compile(r'\brefunds?\b', _I),
    re.compile(r'\bRMA\b'),
    re.compile(r'\bdefective\b[^.!?]*\bcovered\b', _I),
    re.compile(r'\bafter[\s-]sales?\b', _I),
]
REGION = [
    re.compile(r'purchase the version corresponding to your region', _I),
    re.compile(r"\bregion'?s voltage\b", _I),
    re.compile(r'\bpurchase a transformer\b', _I),
]
ORDER = [('money', MONEY), ('promotion', PROMOTION), ('shipping_policy', SHIPPING_POLICY), ('warranty', WARRANTY), ('region', REGION)]
CLASSES = [c for c, _ in ORDER]

# payload.ts REFUSED_FOR: what each text class of a payload string refuses.
REFUSED_FOR = {'customer': {'money', 'promotion', 'shipping_policy', 'warranty'}, 'owner': {'money', 'promotion', 'shipping_policy'}, 'code': set()}


def classify_sentence(s):
    """money > promotion > shipping_policy > warranty > region > keep (same order as sentences.ts classifySentence)."""
    for cls, rxs in ORDER:
        if any(rx.search(s) for rx in rxs):
            return cls
    return 'keep'


_SPLIT = re.compile('(?<=[.!?。])\\s+(?=["“(‘\'A-Z0-9*•-])')


def split_sentences(text):
    """sentences.ts splitSentences: at . ! ? 。 followed by space and a capital, digit or opening mark, and at line breaks."""
    out = []
    for line in re.split(r'\n+', text or ''):
        t = line.strip()
        if not t:
            continue
        for p in _SPLIT.split(t):
            p = p.strip()
            if p:
                out.append(p)
    return out


def text_refusal(s, text_class='customer'):
    """The class that makes payload.ts refuse this string, or None (payload.ts textRefusal: line by line, then at [.!?。] + space)."""
    refused = REFUSED_FOR[text_class]
    if not refused or not s:
        return None
    for line in re.split(r'\n+', s):
        for part in re.split('(?<=[.!?。])\\s+', line):
            c = classify_sentence(part)
            if c in refused:
                return c
    return None
