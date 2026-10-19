const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const router = express.Router();
const { appendSubmittedClaim, notifyDoctor } = require("../lib/claimStore");
const { assemblePreauthForm } = require("../lib/preauthForm");

const FASTAPI_URL = "http://localhost:8001";
const TIMEOUT_MS  = 60000;

const { getDataPath } = require("../lib/dataPath");

async function readJson(filename) {
  const p = getDataPath("mock", filename);
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

function applyEhrOverrides(ehr, body, parsedNote) {
  if (!ehr || typeof ehr !== "object") return ehr;
  const {
    patientName,
    age,
    gender,
    insurerId,
    doctorId,
    diagnosisDesc,
    icd10,
    diagnosisDate,
    labType,
    labDate,
    labFindings,
    prevTreatments,
    treatDuration,
    treatOutcome,
    mriDate,
    ultrasoundDate,
  } = body || {};

  if (patientName) ehr.name = patientName;
  if (gender) ehr.gender = gender;
  if (doctorId) ehr.doctor_id = doctorId;
  if (insurerId) ehr.insurer_id = insurerId;
  if (age !== undefined && age !== null && String(age).trim() !== "") {
    const n = Number(age);
    if (Number.isFinite(n)) ehr.age = n;
  }

  // Diagnosis: if user provided, prefer it (prepend newest entry)
  if (icd10 || diagnosisDesc || parsedNote?.icd10_code) {
    const entry = {
      date: diagnosisDate || new Date().toISOString().split("T")[0],
      icd10: (icd10 || parsedNote?.icd10_code || "").toString(),
      description: diagnosisDesc || "Primary Diagnosis",
    };
    const existing = Array.isArray(ehr.diagnosis_history) ? ehr.diagnosis_history : [];
    ehr.diagnosis_history = [entry, ...existing.filter((_, idx) => idx !== 0)];
  }

  // Labs: ensure at least one relevant lab is present if user provided it
  if (labType || labFindings) {
    const existing = Array.isArray(ehr.lab_reports) ? ehr.lab_reports : [];
    const dyn = {
      id: "LAB_OVERRIDE_1",
      type: labType || "Lab Report",
      date: labDate || new Date().toISOString().split("T")[0],
      result: labFindings || "No findings provided",
      relevant: true,
    };
    const kept = existing.filter((x) => x?.id !== dyn.id);
    ehr.lab_reports = [dyn, ...kept];
  }

  // Imaging helper dates (optional)
  if (mriDate) {
    const existing = Array.isArray(ehr.lab_reports) ? ehr.lab_reports : [];
    const id = "LAB_OVERRIDE_MRI";
    const kept = existing.filter((x) => x?.id !== id);
    ehr.lab_reports = [
      { id, type: "MRI", date: mriDate, result: "MRI study uploaded", relevant: true },
      ...kept,
    ];
  }
  if (ultrasoundDate) {
    const existing = Array.isArray(ehr.lab_reports) ? ehr.lab_reports : [];
    const id = "LAB_OVERRIDE_US";
    const kept = existing.filter((x) => x?.id !== id);
    ehr.lab_reports = [
      { id, type: "Ultrasound", date: ultrasoundDate, result: "Ultrasound study uploaded", relevant: true },
      ...kept,
    ];
  }

  // Prior treatment override
  if (prevTreatments) {
    const existing = Array.isArray(ehr.prior_treatments) ? ehr.prior_treatments : [];
    const entry = {
      type: prevTreatments,
      duration: treatDuration || "Unknown",
      date: new Date().toISOString().split("T")[0],
      outcome: treatOutcome || "Unknown",
    };
    ehr.prior_treatments = [entry, ...existing.filter((_, idx) => idx !== 0)];
  }

  return ehr;
}

const CPT_DESCRIPTIONS = {
  "63030": "Lumbar Discectomy",
  "27447": "Total Knee Arthroplasty",
  "47562": "Laparoscopic Cholecystectomy",
  "43239": "Upper GI Endoscopy with Biopsy",
  "70553": "MRI Brain with Contrast",
  "93306": "Echocardiography",
  "99283": "Emergency Department Visit",
  "44950": "Laparoscopic Appendectomy",
  "92928": "Percutaneous Coronary Intervention (PCI) with Stenting",
};

function parseNoteLocally(text) {
  const cptMatch = text.match(/CPT[\s_]?(?:code)?[\s:_#]*(\d{5})/i);
  let cptRaw = cptMatch ? cptMatch[1] : null;

  let icdMatch = text.match(/ICD-?10[:\s]*([\w]\d{2}\.?\w*)/i);
  if (!icdMatch) icdMatch = text.match(/\b([A-Z]\d{2}\.?\d{0,2})\b/);
  let icd10 = icdMatch ? icdMatch[1].toUpperCase() : null;

  const lower = text.toLowerCase();
  if (!cptRaw) {
    if (lower.includes("discectomy") || lower.includes("lumbar disc")) cptRaw = "63030";
    else if (lower.includes("knee replacement") || lower.includes("knee arthroplasty")) cptRaw = "27447";
    else if (lower.includes("cholecystectomy")) cptRaw = "47562";
    else if (lower.includes("endoscopy")) cptRaw = "43239";
    else if (lower.includes("appendectomy") || lower.includes("appendicitis") || lower.includes("appendix")) cptRaw = "44950";
    else if (lower.includes("stenting") || lower.includes("percutaneous coronary") || lower.includes("pci") || lower.includes("cardiac")) cptRaw = "92928";
  }

  if (!icd10) {
    if (lower.includes("disc herniation") || lower.includes("discectomy") || lower.includes("lumbar")) icd10 = "M51.1";
    else if (lower.includes("knee") && (lower.includes("osteoarthritis") || lower.includes("replacement"))) icd10 = "M17.11";
    else if (lower.includes("cholecystitis") || lower.includes("gallbladder")) icd10 = "K80.20";
    else if (lower.includes("appendicitis") || lower.includes("appendectomy") || lower.includes("appendix")) icd10 = "K37";
    else if (lower.includes("coronary") || lower.includes("stenosis") || lower.includes("angina") || lower.includes("atherosclerotic")) icd10 = "I25.10";
  }

  let urgency = "STANDARD";
  if (["urgent", "emergency", "immediately", "prevent permanent"].some((w) => lower.includes(w))) urgency = "URGENT";
  else if (["elective", "routine", "scheduled"].some((w) => lower.includes(w))) urgency = "ROUTINE";

  return {
    procedure: CPT_DESCRIPTIONS[cptRaw] || "Surgical Procedure",
    cpt_code: cptRaw || "63030",
    icd10_code: icd10 || "M51.1",
    icd10_desc: icd10 || "Primary Diagnosis",
    urgency,
  };
}

const DOCUMENT_KEYWORDS = {
  mri: ["mri", "magnetic resonance"],
  "x-ray": ["x-ray", "xray", "radiograph"],
  ultrasound: ["ultrasound", "sonograph"],
  "coronary angiogram": ["angiogram", "angiography", "cath"],
  electrocardiogram: ["ecg", "electrocardiogram", "ekg"],
  echocardiogram: ["echo", "echocardiogram", "2d echo"],
  cbc: ["cbc", "complete blood count", "blood report", "wbc", "haematology"],
  "cbc & blood": ["cbc", "complete blood count", "blood report", "wbc"],
  "lab report": ["lab", "blood", "cbc", "panel", "report"],
  "nerve conduction": ["nerve conduction", "ncs", "emg", "electromyograph"],
  physiotherapy: ["physical therapy", "physiotherapy", "pt record"],
  "conservative treatment": ["physical therapy", "physiotherapy", "injection", "chiropractic", "nsaid"],
  surgeon: null,
  "surgeon's certificate": null,
  "certificate of medical": null,
  "proof of medical necessity": null,
  "medical necessity": null,
  "surgical clearance": null,
  "hospital admission": ["admission", "admit", "inpatient"],
  "prior endoscopy": ["endoscopy", "scope"],
  "h. pylori": ["pylori", "h pylori"],
};

function docIsInEhr(docType, ehr) {
  const docLower = docType.toLowerCase();
  for (const [key, kws] of Object.entries(DOCUMENT_KEYWORDS)) {
    if (docLower.includes(key) && kws === null) return false;
  }
  let keywords = null;
  for (const [key, kws] of Object.entries(DOCUMENT_KEYWORDS)) {
    if (kws !== null && docLower.includes(key)) {
      keywords = kws;
      break;
    }
  }
  if (!keywords) {
    const words = docLower.split(" ").filter((w) => w.length > 3);
    keywords = words.length ? words.slice(0, 2) : [docLower.slice(0, 6)];
  }

  const labs = ehr.lab_reports || [];
  const treatments = ehr.prior_treatments || [];
  const diagnoses = ehr.diagnosis_history || [];

  for (const lab of labs) {
    const labText = `${lab.type || ""} ${lab.result || ""}`.toLowerCase();
    if (keywords.some((kw) => labText.includes(kw))) return true;
  }

  for (const tx of treatments) {
    const txText = `${tx.type || ""} ${tx.outcome || ""}`.toLowerCase();
    if (keywords.some((kw) => txText.includes(kw))) return true;
  }

  if (docLower.includes("hospital admission") || docLower.includes("admission form")) {
    return diagnoses.length > 0;
  }

  return false;
}

function extractEhrLocally(ehr, requirements) {
  const matched_diagnoses = ehr.diagnosis_history || [];
  const relevant_labs = (ehr.lab_reports || [])
    .filter((l) => l.relevant !== false)
    .map((l) => ({ type: l.type, date: l.date || "", findings: l.result || "" }));
  const prior_treatments = ehr.prior_treatments || [];
  const medications = ehr.medications || [];

  const found_documents = [];
  const missing_documents = [];
  for (const doc of requirements) {
    if (docIsInEhr(doc, ehr)) {
      found_documents.push(doc);
    } else {
      missing_documents.push(doc);
    }
  }

  return {
    matched_diagnoses,
    relevant_labs,
    prior_treatments,
    medications,
    missing_documents,
    found_documents,
    patient_name: ehr.name || "",
    policy_number: `POL-${ehr.insurer_id || ""}-2024`,
    evidence_summary: {
      total_labs: (ehr.lab_reports || []).length,
      relevant_labs: relevant_labs.length,
      treatments_count: prior_treatments.length,
      diagnoses_count: matched_diagnoses.length,
      medications_count: medications.length,
      medications_summary: medications.map((m) => m.name || "").filter(Boolean).join(", "),
    },
  };
}

// POST /api/analyze
router.post("/", async (req, res) => {
  try {
    const { 
        patientId, insurerId, procedureId, surgeonNoteText, note,
        patientName, dob, age, gender, policyNumber, doctorId, hospital,
        diagnosisDesc, icd10, diagnosisDate, diagnosisNotes, surgeryDate, costEstimate,
        prevTreatments, treatDuration, treatOutcome,
        labType, labDate, labFindings, mriDate, ultrasoundDate,
        certSurgeon, medicalLicense, claimId, submissionDate, bmi 
    } = req.body;
    const noteText = surgeonNoteText || note || "";

    if (!patientId || !noteText) {
      return res.status(400).json({ error: "Missing required fields: patientId, surgeonNoteText" });
    }

    // ── Step 1: Parse surgeon note (FastAPI if online, otherwise local fallback) ───
    let parsedNote;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500); // 1.5s timeout
      const r = await fetch(`${FASTAPI_URL}/parse_note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: noteText }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        parsedNote = await r.json();
      }
    } catch (_) {
      // Python FastAPI unavailable or timed out; fall through to local parser
    }

    if (!parsedNote) {
      parsedNote = parseNoteLocally(noteText);
    }

    const cptKey = parsedNote.cpt_code
      ? `CPT_${parsedNote.cpt_code}`
      : (procedureId || "CPT_63030");

    // ── Step 2: Load EHR + policy from mock JSON ────────────────────────────
    const [allEhr, policies] = await Promise.all([
      readJson("patient_ehr.json"),
      readJson("insurance_policies.json"),
    ]);

    let ehr = allEhr[patientId] || (allEhr.patient_id === patientId ? allEhr : null);
    
    if (!ehr) {
      // Build dynamic EHR based on request parameters
      console.log(`[analyze] Patient ${patientId} not found in mock data. Generating dynamic EHR...`);
      ehr = {
        patient_id: patientId,
        name: patientName || "Unknown Patient",
        age: age ? parseInt(age) : 45,
        gender: gender || "Unknown",
        insurer_id: insurerId || "Unknown",
        doctor_id: doctorId || "Unknown",
        diagnosis_history: [],
        lab_reports: [],
        medications: [],
        prior_treatments: []
      };

      if (icd10 || diagnosisDesc) {
         ehr.diagnosis_history.push({
           date: diagnosisDate || new Date().toISOString().split('T')[0],
           icd10: icd10 || parsedNote?.icd10_code || 'N/A',
           description: diagnosisDesc || 'Primary Diagnosis'
         });
      }

      if (labType || labFindings) {
         ehr.lab_reports.push({
           id: "LAB_DYN_1",
           type: labType || "Lab Report",
           date: labDate || new Date().toISOString().split('T')[0],
           result: labFindings || "No findings provided",
           relevant: true
         });
      }

      if (mriDate && labType !== 'MRI') {
          ehr.lab_reports.push({
              id: "LAB_DYN_2", type: "MRI", date: mriDate, result: "MRI study uploaded", relevant: true
          });
      }
      if (ultrasoundDate && labType !== 'Ultrasound') {
          ehr.lab_reports.push({
              id: "LAB_DYN_3", type: "Ultrasound", date: ultrasoundDate, result: "Ultrasound study uploaded", relevant: true
          });
      }

      if (prevTreatments) {
          ehr.prior_treatments.push({
              type: prevTreatments,
              duration: treatDuration || "Unknown",
              date: new Date().toISOString().split('T')[0],
              outcome: treatOutcome || "Unknown"
          });
      }
    }

    // Even when patient exists in mock data (e.g. PAT_001), apply UI-entered overrides
    ehr = applyEhrOverrides(ehr, req.body, parsedNote);

    ehr.insurer_id = insurerId || ehr.insurer_id;
    ehr.cpt_code   = cptKey;

    const insurerKey = insurerId || ehr.insurer_id;
    const procedurePolicy = policies[insurerKey]?.procedures?.[cptKey];
    let requirements = procedurePolicy?.required_documents || [];

    // Fallback if the user typed a completely unmapped/novel procedure
    if (requirements.length === 0) {
        requirements = [
            "Physician Intake Notes",
            "Proof of Medical Necessity",
            "Surgical Clearance"
        ];
    }

    // ── Step 3: Extract EHR evidence + gaps (FastAPI if online, otherwise local fallback) ──
    let ehrResult;
    try {
      const ctrlEhr = new AbortController();
      const timerEhr = setTimeout(() => ctrlEhr.abort(), 1500);
      const ehrResp = await fetch(`${FASTAPI_URL}/extract_ehr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ehr, requirements }),
        signal: ctrlEhr.signal,
      });
      clearTimeout(timerEhr);
      if (ehrResp.ok) {
        ehrResult = await ehrResp.json();
      }
    } catch (_) {
      // Python FastAPI unavailable or timed out; fall through to local extractor
    }

    if (!ehrResult) {
      ehrResult = extractEhrLocally(ehr, requirements);
    }

    // ── Step 4: Run Node Logic Modules ─────────────────────────────
    const logicManager = req.logicManager;
    const logicResult = await logicManager.processPreAuth({
        diagnosisText: parsedNote.icd10_desc || parsedNote.icd10_code || noteText,
        insurerId: insurerKey,
        procedureCode: cptKey,
        extractedDocs: ehrResult.found_documents || []
    });

    const missingDocs = logicResult.gaps.missingDocs || [];
    const docId = ehr?.doctor_id || doctorId || "UNKNOWN";
    const claimIdForStore = claimId || `CLM_${Date.now()}`;

    // Assemble pre-auth form with cited evidence (problem statement #5)
    const preauthForm = assemblePreauthForm({
      patientId,
      patientName: ehrResult.patient_name || patientName || "Unknown",
      procedure: parsedNote.procedure,
      cptCode: cptKey,
      icd10Code: logicResult.diagnosis.icd10 || parsedNote.icd10_code,
      insurerId: insurerKey,
      policyNumber: ehrResult.policy_number || policyNumber,
      requiredDocuments: requirements,
      foundDocuments: ehrResult.found_documents || [],
      ehrEvidence: ehrResult,
      riskLevel: logicResult.risk.riskLevel,
      riskScore: logicResult.risk.riskScore,
      topDrivers: logicResult.risk.reasons,
      maxApproved: procedurePolicy?.max_approved_amount,
      preauthDays: procedurePolicy?.preauth_timeline_days,
    });

    // Notify doctor if gaps (problem statement #4 — actionable alert)
    let doctorAlert = null;
    if (missingDocs.length > 0) {
      doctorAlert = await notifyDoctor(
        docId,
        claimIdForStore,
        patientId,
        ehrResult.patient_name || patientName || "Unknown",
        missingDocs
      );
    }

    const riskLevel = logicResult.risk.riskLevel.toUpperCase();
    const status = riskLevel === "HIGH" ? "Rejected" : (riskLevel === "MEDIUM" ? "Pending" : "Approved");

    // Persist so claim appears in analytics/history after refresh
    await appendSubmittedClaim({
      id: claimIdForStore,
      patientId,
      patientName: ehrResult.patient_name || patientName || "Unknown",
      procedure: parsedNote.procedure || "Procedure",
      cpt_code: cptKey,
      insurerId: insurerKey,
      insurerName: policies[insurerKey]?.name || insurerKey,
      cost: costEstimate ? `₹${Number(costEstimate).toLocaleString("en-IN")}` : "₹0",
      submitted: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit" }),
      submittedAt: new Date().toISOString(),
      risk: riskLevel === "HIGH" ? "High" : (riskLevel === "MEDIUM" ? "Medium" : "Low"),
      status,
      missingDocs,
    });

    return res.json({
      success: true,
      parsedNote: {
        procedure:  parsedNote.procedure,
        cpt_code:   parsedNote.cpt_code || cptKey.replace("CPT_", ""),
        icd10_code: logicResult.diagnosis.icd10 || parsedNote.icd10_code,
        urgency:    parsedNote.urgency,
      },
      ehrEvidence: {
        patient_name:      ehrResult.patient_name,
        policy_number:     ehrResult.policy_number,
        matched_diagnoses: ehrResult.matched_diagnoses || [],
        relevant_labs:     ehrResult.relevant_labs || [],
        prior_treatments:  ehrResult.prior_treatments || [],
        medications:       ehrResult.medications || [],
        missing_documents: missingDocs,
        evidence_summary:  ehrResult.evidence_summary || {},
      },
      gapAnalysis: {
        missingEvidence: missingDocs,
      },
      risk: {
        level:      riskLevel,
        score:      logicResult.risk.riskScore,
        topDrivers: logicResult.risk.reasons || [],
      },
      request: { patientId, insurerId: insurerKey, claimId: claimIdForStore, costEstimate },
      policy_used: {
        cpt:                cptKey,
        required_documents: requirements,
        max_approved:       procedurePolicy?.max_approved_amount || 0,
        preauth_days:       procedurePolicy?.preauth_timeline_days || 14,
      },
      preauth_form: preauthForm,
      doctor_alert:  doctorAlert ? { sent: true, alertId: doctorAlert.id, message: doctorAlert.message, missing_docs: doctorAlert.missingDocs } : null,
    });

  } catch (err) {
    console.error("Analyze error:", err);
    return res.status(500).json({ error: "Analyze pipeline failed", details: err.message });
  }
});

module.exports = router;