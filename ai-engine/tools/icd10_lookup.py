import os
import pandas as pd
import re
from collections import defaultdict

# ── 1. Load the cleaned CSV ──────────────────────────────────────────────────
_CSV_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "processed", "icd10_lookup_clean.csv"))
if not os.path.exists(_CSV_PATH):
    _RAW_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "raw", "icd10_codeset.csv"))
    df = pd.read_csv(_RAW_PATH)
    df = df.rename(columns={"ICDCode": "icd10_code", "Description": "description"}).dropna()
else:
    df = pd.read_csv(_CSV_PATH)

df["icd10_code"] = df["icd10_code"].astype(str).str.strip()
df["description"] = df["description"].astype(str).str.strip()

# ── 2. Build Inverted Index over all 73,639 codes ─────────────────────────────
_TOKEN_INDEX = defaultdict(set)
_STOPWORDS = {"and", "with", "the", "for", "in", "of", "to", "or", "a", "an", "by", "other", "unspecified"}

for idx, desc in enumerate(df["description"]):
    words = set(re.findall(r'\b[a-zA-Z0-9]{2,}\b', desc.lower()))
    for w in words:
        if w not in _STOPWORDS:
            _TOKEN_INDEX[w].add(idx)

# Keyword alias map
ALIASES = {
    "lumbar disc herniation": ["intervertebral", "disc", "lumbar"],
    "disc herniation": ["intervertebral", "disc", "displacement"],
    "knee osteoarthritis": ["osteoarthritis", "knee"],
    "knee replacement": ["osteoarthritis", "knee"],
    "cholecystitis": ["cholecystitis"],
    "gallstones": ["calculus", "gallbladder"],
    "low back pain": ["low", "back", "pain"],
    "appendicitis": ["appendicitis"],
    "heart attack": ["myocardial", "infarction"],
    "high blood pressure": ["essential", "hypertension"],
    "kidney failure": ["renal", "failure"],
    "stroke": ["cerebral", "infarction"],
}

# ── 3. Ultra-Fast Lookup function ───────────────────────────────────────────
def lookup_icd10_code(diagnosis_text: str, top_n: int = 5) -> list:
    query = str(diagnosis_text).strip()
    if not query:
        return [{"icd10_code": "NOT_FOUND", "description": "Empty query"}]

    # A. Bare ICD-10 code lookup (e.g. "M51.1", "K35.80", "I25")
    clean_code = re.sub(r'[^A-Z0-9.]', '', query.upper())
    if re.match(r'^[A-Z]\d{2}(\.?\w{0,4})?$', clean_code):
        # Exact match
        exact = df[df["icd10_code"].str.upper() == clean_code]
        if not exact.empty:
            return exact.head(top_n).to_dict(orient="records")
        
        # Strip decimal dot if not found directly
        no_dot = clean_code.replace(".", "")
        exact_no_dot = df[df["icd10_code"].str.upper().str.replace(".", "", regex=False) == no_dot]
        if not exact_no_dot.empty:
            return exact_no_dot.head(top_n).to_dict(orient="records")

        # Prefix match (e.g. M51 matches M51.1, M51.16...)
        prefix = df[df["icd10_code"].str.upper().str.startswith(clean_code[:3])]
        if not prefix.empty:
            return prefix.head(top_n).to_dict(orient="records")

    # B. Text/Keyword search across 73,639 codes using inverted index
    query_lower = query.lower()
    
    # Check aliases
    expanded_words = []
    for alias_key, alias_val in ALIASES.items():
        if alias_key in query_lower:
            expanded_words.extend(alias_val)

    q_words = [w for w in re.findall(r'\b[a-zA-Z0-9]{2,}\b', query_lower) if w not in _STOPWORDS]
    all_search_words = list(dict.fromkeys(q_words + expanded_words))

    if not all_search_words:
        all_search_words = [query_lower]

    # Calculate token matches and rank by relevance score
    candidate_scores = defaultdict(float)
    
    for w in all_search_words:
        matched_indices = _TOKEN_INDEX.get(w, set())
        for idx in matched_indices:
            candidate_scores[idx] += 1.0

    if candidate_scores:
        # Boost exact phrase match
        for idx in list(candidate_scores.keys()):
            desc = df.iloc[idx]["description"].lower()
            if query_lower in desc:
                candidate_scores[idx] += 3.0
            # Normalize by length of description
            candidate_scores[idx] /= (len(desc.split()) ** 0.3)

        # Sort top candidates
        top_indices = sorted(candidate_scores.keys(), key=lambda i: candidate_scores[i], reverse=True)[:top_n]
        return df.iloc[top_indices].to_dict(orient="records")

    # Fallback substring search
    mask = df["description"].str.contains(query_lower[:8], case=False, na=False)
    fallback = df[mask].head(top_n)
    if not fallback.empty:
        return fallback.to_dict(orient="records")

    return [{"icd10_code": "NOT_FOUND", "description": f"No ICD-10 code found for: {query}"}]


# ── 4. Test ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    tests = [
        "M51.1",                  # direct code lookup
        "lumbar disc herniation", # text search
        "knee osteoarthritis",
        "M17.11",                 # direct code lookup
        "low back pain",
    ]
    for test in tests:
        print(f"\nQuery: '{test}'")
        matches = lookup_icd10_code(test)
        for m in matches:
            print(f"  {m['icd10_code']} → {m['description']}")