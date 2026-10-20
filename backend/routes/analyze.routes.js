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
    surgeonNoteText,
    note,
    certNotes,
    certSurgeon,
    medicalLicense,
    providedEvidence
  } = body || {};

  const noteContent = (surgeonNoteText || note || certNotes || "").trim();
  ehr.has_surgeon_letter = !!(providedEvidence?.hasSurgeonNote || noteContent.length > 20 || (certSurgeon && medicalLicense));
  ehr.surgeon_notes = noteContent;
  ehr.has_imaging = !!(providedEvidence?.hasImaging || mriDate || ultrasoundDate || (labType && /mri|x-?ray|ultrasound|ct|echo|angiogram|biometry|pns/i.test(labType)));
  ehr.has_conservative_history = !!(providedEvidence?.hasConservativeHistory || prevTreatments || treatDuration);
  ehr.has_labs = !!(providedEvidence?.hasLabs || labType || labFindings || labDate);
  ehr.has_cert = !!(providedEvidence?.hasCert || (certSurgeon && medicalLicense) || noteContent.length > 20);

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
  "27447": "Total Knee Arthroplasty (Knee Replacement)",
  "27130": "Total Hip Replacement (Hip Arthroplasty)",
  "29888": "ACL Reconstruction (Knee Ligament Repair)",
  "29827": "Rotator Cuff Repair / Shoulder Arthroscopy",
  "22551": "Anterior Cervical Discectomy & Fusion (ACDF)",
  "47562": "Laparoscopic Cholecystectomy",
  "44950": "Laparoscopic Appendectomy",
  "49505": "Inguinal Hernia Repair",
  "92928": "Percutaneous Coronary Intervention (PCI) with Stenting",
  "33533": "Coronary Artery Bypass Graft (CABG)",
  "43239": "Upper GI Endoscopy with Biopsy",
  "45378": "Diagnostic & Therapeutic Colonoscopy",
  "66984": "Cataract Surgery with Phacoemulsification & IOL",
  "31255": "Functional Endoscopic Sinus Surgery (FESS)",
  "58571": "Total Laparoscopic Hysterectomy",
  "52601": "Transurethral Resection of Prostate (TURP)",
  "70553": "MRI Brain with Contrast",
  "93306": "Echocardiography",
  "99283": "Emergency Department Visit",
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
    else if (lower.includes("hip replacement") || lower.includes("hip arthroplasty")) cptRaw = "27130";
    else if (lower.includes("acl") || lower.includes("cruciate ligament")) cptRaw = "29888";
    else if (lower.includes("rotator cuff") || lower.includes("shoulder arthroscopy")) cptRaw = "29827";
    else if (lower.includes("cervical fusion") || lower.includes("acdf") || lower.includes("cervical discectomy")) cptRaw = "22551";
    else if (lower.includes("cholecystectomy") || lower.includes("gallbladder")) cptRaw = "47562";
    else if (lower.includes("appendectomy") || lower.includes("appendicitis") || lower.includes("appendix")) cptRaw = "44950";
    else if (lower.includes("hernia")) cptRaw = "49505";
    else if (lower.includes("cabg") || lower.includes("bypass graft")) cptRaw = "33533";
    else if (lower.includes("stenting") || lower.includes("pci") || lower.includes("coronary")) cptRaw = "92928";
    else if (lower.includes("endoscopy") || lower.includes("gastroscopy")) cptRaw = "43239";
    else if (lower.includes("colonoscopy")) cptRaw = "45378";
    else if (lower.includes("cataract") || lower.includes("phaco")) cptRaw = "66984";
    else if (lower.includes("sinus") || lower.includes("fess")) cptRaw = "31255";
    else if (lower.includes("hysterectomy")) cptRaw = "58571";
    else if (lower.includes("prostate") || lower.includes("turp")) cptRaw = "52601";
  }

  if (!icd10) {
    if (lower.includes("disc herniation") || lower.includes("discectomy") || lower.includes("lumbar")) icd10 = "M51.1";
    else if (lower.includes("knee") && (lower.includes("osteoarthritis") || lower.includes("replacement"))) icd10 = "M17.11";
    else if (lower.includes("hip") && (lower.includes("osteoarthritis") || lower.includes("replacement"))) icd10 = "M16.11";
    else if (lower.includes("cholecystitis") || lower.includes("gallbladder")) icd10 = "K80.20";
    else if (lower.includes("appendicitis") || lower.includes("appendectomy") || lower.includes("appendix")) icd10 = "K37";
    else if (lower.includes("hernia")) icd10 = "K40.90";
    else if (lower.includes("coronary") || lower.includes("stenosis") || lower.includes("angina") || lower.includes("atherosclerotic")) icd10 = "I25.10";
    else if (lower.includes("cataract")) icd10 = "H25.11";
    else if (lower.includes("sinus")) icd10 = "J32.9";
    else if (lower.includes("prostate") || lower.includes("bph")) icd10 = "N40.1";
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

function docIsInEhr(docType, ehr) {
  const docLower = docType.toLowerCase();

  // Clinician / Surgeon notes & recommendation
  if (docLower.includes("surgeon") || docLower.includes("recommendation") || docLower.includes("physician intake") || docLower.includes("evaluat") || docLower.includes("clinical note") || docLower.includes("referr")) {
    return !!(ehr.has_surgeon_letter || (ehr.surgeon_notes && ehr.surgeon_notes.length > 20) || (ehr.clinical_notes && ehr.clinical_notes.length > 20));
  }

  // Certificate of medical necessity / clearance
  if (docLower.includes("certificate") || docLower.includes("medical necessity") || docLower.includes("clearance") || docLower.includes("consent")) {
    return !!(ehr.has_cert || ehr.has_surgeon_letter || (ehr.surgeon_notes && ehr.surgeon_notes.length > 20));
  }

  // Conservative treatment / Physical therapy / Rehab
  if (docLower.includes("conservative") || docLower.includes("therapy") || docLower.includes("physio") || docLower.includes("rehab")) {
    return !!(ehr.has_conservative_history || (Array.isArray(ehr.prior_treatments) && ehr.prior_treatments.length > 0));
  }

  // Imaging checks (MRI, X-Ray, CT, Ultrasound, Echo, Angiogram, Biometry, PNS)
  if (["mri", "x-ray", "xray", "ultrasound", "usg", "ct", "angiogram", "echo", "biometry", "pns"].some(term => docLower.includes(term))) {
    if (ehr.has_imaging) return true;
    const labs = ehr.lab_reports || [];
    return labs.some(l => {
      const txt = `${l.type || ""} ${l.result || ""}`.toLowerCase();
      return ["mri", "x-ray", "xray", "ultrasound", "usg", "ct", "angiogram", "echo", "biometry", "pns"].some(term => txt.includes(term));
    });
  }

  // Lab reports (CBC, LFT, Blood, H. Pylori, Biopsy, PSA, FOBT, Pre-op labs)
  if (["cbc", "lft", "blood", "lab", "pylori", "biopsy", "psa", "fobt", "pre-op"].some(term => docLower.includes(term))) {
    if (ehr.has_labs) return true;
    const labs = ehr.lab_reports || [];
    return labs.length > 0;
  }

  // General fallback keyword matching
  const labs = ehr.lab_reports || [];
  const treatments = ehr.prior_treatments || [];
  for (const lab of labs) {
    const labText = `${lab.type || ""} ${lab.result || ""}`.toLowerCase();
    if (docLower.split(' ').some(w => w.length > 3 && labText.includes(w))) return true;
  }
  for (const tx of treatments) {
    const txText = `${tx.type || ""} ${tx.outcome || ""}`.toLowerCase();
    if (docLower.split(' ').some(w => w.length > 3 && txText.includes(w))) return true;
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
    let matchedPolicy = policies[insurerKey];
    if (!matchedPolicy && insurerKey) {
      const q = insurerKey.toLowerCase().trim();
      matchedPolicy = Object.values(policies).find(p =>
        (p.name && (p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()))) ||
        (p.insurer_id && p.insurer_id.toLowerCase() === q)
      );
    }
    const procedurePolicy = matchedPolicy?.procedures?.[cptKey] ||
      Object.values(policies).map(p => p.procedures?.[cptKey]).find(Boolean);
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
      insurerName: matchedPolicy?.name || policies[insurerKey]?.name || insurerKey,
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
        found_documents:   ehrResult.found_documents || [],
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