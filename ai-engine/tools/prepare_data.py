import pandas as pd
import numpy as np
import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

RAW = "data/raw"
PROCESSED = "data/processed"
os.makedirs(PROCESSED, exist_ok=True)

# ── 1. Clean ICD-10 codeset ──────────────────────────────────────────────────
print("Cleaning icd10_codeset.csv...")
icd = pd.read_csv(RAW + "/icd10_codeset.csv")

icd = icd.rename(columns={
    "ICDCode": "icd10_code",
    "Description": "description"
})
icd["icd10_code"] = icd["icd10_code"].str.strip()
icd["description"] = icd["description"].str.strip().str.lower()
icd = icd.dropna()
icd = icd.drop_duplicates(subset="icd10_code")

icd.to_csv(PROCESSED + "/icd10_lookup_clean.csv", index=False)
print(f"Saved {len(icd)} ICD-10 codes → processed/icd10_lookup_clean.csv")

# ── 2. Clean medical claims ──────────────────────────────────────────────────
print("\nCleaning medical_claims.csv...")
med = pd.read_csv(RAW + "/medical_claims.csv")

med = med[[
    "encounter_id",
    "patient_id",
    "MedicalCondition",
    "admission_type",
    "medication",
    "test_resultS",
    "billing_amount",
    "insurance_provider_name"
]]

med = med.rename(columns={
    "MedicalCondition": "medical_condition",
    "test_resultS": "test_results"
})

med["medical_condition"] = med["medical_condition"].str.strip().str.lower()
med["medication"] = med["medication"].str.strip()
med = med.dropna(subset=["medical_condition"])

med.to_csv(PROCESSED + "/medical_claims_clean.csv", index=False)
print(f"Saved {len(med)} claims → processed/medical_claims_clean.csv")

# ── 3. Build risk_training_data.csv ─────────────────────────────────────────
print("\nBuilding risk_training_data.csv (Merging enhanced_claims & medical_claims)...")
enhanced = pd.read_csv(RAW + "/enhanced_claims.csv")

risk_enh = pd.DataFrame()
risk_enh["claim_id"]          = enhanced["ClaimID"]
risk_enh["insurer_id"]        = enhanced["ProviderID"]
risk_enh["cpt_code"]          = enhanced["ProcedureCode"]
risk_enh["claim_amount"]      = enhanced["ClaimAmount"]
risk_enh["patient_age"]       = enhanced["PatientAge"]
risk_enh["claim_type"]        = enhanced["ClaimType"]
risk_enh["submission_method"] = enhanced["ClaimSubmissionMethod"]
risk_enh["label_rejected"]    = (enhanced["ClaimStatus"] == "Denied").astype(int)

# Merge medical_claims.csv (12,684 rows)
np.random.seed(42)
risk_med = pd.DataFrame()
risk_med["claim_id"]          = "MED_" + med["encounter_id"].astype(str)
risk_med["insurer_id"]        = med["insurance_provider_name"].fillna("Unknown")
risk_med["cpt_code"]          = med["medical_condition"].fillna("General")
risk_med["claim_amount"]      = pd.to_numeric(med["billing_amount"], errors="coerce").fillna(50000)
risk_med["patient_age"]       = np.random.randint(18, 82, size=len(med))
risk_med["claim_type"]        = med["admission_type"].map({"Emergency": "Emergency", "Urgent": "Urgent", "Elective": "Routine"}).fillna("Routine")
risk_med["submission_method"] = np.random.choice(["Electronic", "Paper"], size=len(med), p=[0.78, 0.22])

med_rej_prob = (
    0.10 + 
    0.15 * (med["test_results"] == "Inconclusive").astype(float) +
    0.10 * (med["test_results"] == "Abnormal").astype(float) +
    0.12 * (risk_med["claim_amount"] > risk_med["claim_amount"].quantile(0.75)).astype(float) +
    0.08 * (risk_med["submission_method"] == "Paper").astype(float)
)
risk_med["label_rejected"] = (np.random.rand(len(med)) < med_rej_prob).astype(int)

risk = pd.concat([risk_enh, risk_med], ignore_index=True)

# ── Richer engineered features ──
amount_median = risk["claim_amount"].median()
amount_75p    = risk["claim_amount"].quantile(0.75)
amount_90p    = risk["claim_amount"].quantile(0.90)

risk["is_high_amount"]      = (risk["claim_amount"] > amount_median).astype(int)
risk["is_very_high_amount"] = (risk["claim_amount"] > amount_90p).astype(int)
risk["amount_vs_median"]    = risk["claim_amount"] / (amount_median + 1)

risk["is_paper_submission"] = (risk["submission_method"] == "Paper").astype(int)
risk["is_routine"]          = (risk["claim_type"] == "Routine").astype(int)
risk["is_emergency"]        = (risk["claim_type"] == "Emergency").astype(int)

risk["is_older_patient"]    = (risk["patient_age"] > 60).astype(int)
risk["is_pediatric"]        = (risk["patient_age"] < 18).astype(int)
risk["age_bucket"]          = pd.cut(
    risk["patient_age"],
    bins=[0, 18, 35, 50, 65, 120],
    labels=[0, 1, 2, 3, 4],
    include_lowest=True
).cat.add_categories(-1).fillna(-1).astype(int)

risk = risk.dropna()
risk.to_csv(PROCESSED + "/risk_training_data.csv", index=False)
print(f"Saved {len(risk)} rows → processed/risk_training_data.csv")
print(f"Rejection rate: {risk['label_rejected'].mean()*100:.1f}%")

# ── 4. Build gap_analysis_data.csv ──────────────────────────────────────────
# FIX: Remove `billed_vs_paid` — it IS the label (data leakage).
# Use only features that would be known BEFORE the outcome.
print("\nBuilding gap_analysis_data.csv...")
synthetic = pd.read_csv(RAW + "/synthetic_hc_claims.csv")

gap = pd.DataFrame()
gap["case_id"]      = synthetic["Claim ID"]
gap["insurer_id"]   = synthetic["Provider ID"]
gap["procedure_id"] = synthetic["Procedure Code"]

# Features knowable BEFORE outcome is determined
gap["follow_up_required"] = (synthetic["Follow-up Required"] == "Yes").astype(int)
gap["is_under_review"]    = (synthetic["Claim Status"] == "Under Review").astype(int)
gap["is_pending_ar"]      = (synthetic["AR Status"] == "Pending").astype(int)
gap["is_open_ar"]         = (synthetic["AR Status"] == "Open").astype(int)

# Billed amount alone (not ratio with paid — paid is post-outcome)
gap["billed_amount"]      = synthetic["Billed Amount"]
gap["log_billed_amount"]  = np.log1p(synthetic["Billed Amount"])

# Is billed amount unusually high for this procedure? (z-score per procedure)
gap["billed_zscore"] = (
    gap.groupby("procedure_id")["billed_amount"]
    .transform(lambda x: (x - x.mean()) / (x.std() + 1e-9))
)

# Label: 1 = has a gap (denied or partially paid)
gap["label_has_gap"] = (
    synthetic["Outcome"].isin(["Denied", "Partially Paid"])
).astype(int)

gap = gap.dropna()
gap.to_csv(PROCESSED + "/gap_analysis_data.csv", index=False)
print(f"Saved {len(gap)} rows → processed/gap_analysis_data.csv")
print(f"Gap rate: {gap['label_has_gap'].mean()*100:.1f}%")

print("\nAll preprocessing done!")