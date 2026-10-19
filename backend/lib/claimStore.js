const fs = require("fs").promises;
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const { getDataPath } = require("./dataPath");

const SUBMITTED_PATH = getDataPath("mock", "submitted_claims.json");
const ALERTS_PATH = getDataPath("mock", "doctor_alerts.json");
const APPEALS_PATH = getDataPath("mock", "appeals.json");
const INSURER_RESPONSES_PATH = getDataPath("mock", "insurer_responses.json");
const HISTORICAL_REJECTIONS_PATH = getDataPath("mock", "historical_rejections.json");

// ─── DynamoDB Configuration ────────────────────────────────────────────────
const TABLE_NAME = process.env.DYNAMODB_TABLE || "ClearClaim_Data";

function isDynamoEnabled() {
  return !!process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.USE_DYNAMODB === "true";
}

let docClient = null;
function getDocClient() {
  if (!docClient) {
    const client = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

// ─── Local JSON Helpers (Fallback) ──────────────────────────────────────────
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    return [];
  }
}

async function writeJson(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    // Read-only filesystem in Lambda is safe to ignore when DynamoDB is active
  }
}

// ─── Claims ─────────────────────────────────────────────────────────────────
/** Persist a submitted claim so it appears in analytics/history. */
async function appendSubmittedClaim(claim) {
  const claimRecord = {
    id: claim.id || `CLM_${Date.now()}`,
    patientId: claim.patientId,
    patientName: claim.patientName,
    procedure: claim.procedure,
    cpt_code: claim.cpt_code,
    insurerId: claim.insurerId,
    insurerName: claim.insurerName,
    cost: claim.cost,
    submitted: claim.submitted !== false,
    submittedAt: claim.submittedAt || new Date().toISOString(),
    risk: claim.risk || "Low",
    status: claim.status || "Approved",
    missingDocs: claim.missingDocs || [],
  };

  if (isDynamoEnabled()) {
    try {
      await getDocClient().send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: "CLAIM",
            SK: `CLAIM#${claimRecord.id}`,
            ...claimRecord,
          },
        })
      );
      return claimRecord;
    } catch (e) {
      console.warn("[DynamoDB] appendSubmittedClaim error, fallback to local:", e.message);
    }
  }

  const list = await readJson(SUBMITTED_PATH);
  list.unshift(claimRecord);
  await writeJson(SUBMITTED_PATH, list);
  return claimRecord;
}

/** Return all submitted claims (for analytics merge). */
async function getSubmittedClaims() {
  let dynamoItems = [];
  if (isDynamoEnabled()) {
    try {
      const res = await getDocClient().send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "CLAIM" },
        })
      );
      dynamoItems = res.Items || [];
    } catch (e) {
      console.warn("[DynamoDB] getSubmittedClaims error, fallback to local:", e.message);
    }
  }

  const localList = await readJson(SUBMITTED_PATH);
  if (dynamoItems.length === 0) return localList;

  const seenIds = new Set(dynamoItems.map((d) => d.id));
  return [...dynamoItems, ...localList.filter((l) => !seenIds.has(l.id))];
}

// ─── Alerts ─────────────────────────────────────────────────────────────────
/** Record a doctor alert (missing docs). */
async function notifyDoctor(doctorId, claimId, patientId, patientName, missingDocs) {
  const alert = {
    id: `ALT_${Date.now()}`,
    doctorId: doctorId || "DOC_DEFAULT",
    claimId,
    patientId,
    patientName,
    missingDocs: missingDocs || [],
    message: `Action required: Please provide the following for claim ${claimId}: ${(missingDocs || []).join(", ")}`,
    createdAt: new Date().toISOString(),
    read: false,
  };

  if (isDynamoEnabled()) {
    try {
      await getDocClient().send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: "ALERT",
            SK: `ALERT#${alert.id}`,
            ...alert,
          },
        })
      );
      return alert;
    } catch (e) {
      console.warn("[DynamoDB] notifyDoctor error, fallback to local:", e.message);
    }
  }

  const list = await readJson(ALERTS_PATH);
  list.unshift(alert);
  await writeJson(ALERTS_PATH, list);
  return alert;
}

/** Get all doctor alerts. */
async function getDoctorAlerts() {
  let dynamoItems = [];
  if (isDynamoEnabled()) {
    try {
      const res = await getDocClient().send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ALERT" },
        })
      );
      dynamoItems = res.Items || [];
    } catch (e) {
      console.warn("[DynamoDB] getDoctorAlerts error, fallback to local:", e.message);
    }
  }

  const localList = await readJson(ALERTS_PATH);
  if (dynamoItems.length === 0) return localList;
  const seenIds = new Set(dynamoItems.map((d) => d.id));
  return [...dynamoItems, ...localList.filter((l) => !seenIds.has(l.id))];
}

// ─── Rejections & Appeals ───────────────────────────────────────────────────
const REJECTION_ACTIONS = {
  MISSING_DOCUMENT: ["Request missing document from provider", "Re-submit pre-auth packet"],
  INCORRECT_CODING: ["Validate ICD-10/CPT mapping", "Correct codes and re-submit"],
  POLICY_MISMATCH: ["Check policy constraints", "Collect additional supporting evidence"],
  STALE_DOCUMENT: ["Obtain current report within policy timeframe", "Re-submit with updated document"],
  INSUFFICIENT_TREATMENT_HISTORY: ["Document conservative treatment duration", "Re-submit with complete history"],
  INVALID_DOCUMENT: ["Obtain signed/valid document", "Re-submit corrected document"],
};

function mapRejectionToActions(rejectionCategory) {
  return REJECTION_ACTIONS[rejectionCategory] || ["Review rejection details", "Collect supporting evidence"];
}

function draftAppealLetter(patientId, claimId, reason) {
  return `To Whom It May Concern,

Re: Appeal for Claim ${claimId} (Patient ${patientId})

We are writing to appeal the denial based on: ${reason}

We have attached the requested documentation and confirm medical necessity per the enclosed evidence. We request reconsideration and approval of this pre-authorization.

Sincerely,
Billing Team`;
}

/** Record rejection and create appeal; return appeal record. */
async function recordRejectionAndAppeal(claimId, patientId, rejectionReason, rejectionCategory) {
  const actions = mapRejectionToActions(rejectionCategory || "MISSING_DOCUMENT");
  const letter = draftAppealLetter(patientId, claimId, rejectionReason);
  const appeal = {
    id: `APL_${Date.now()}`,
    claimId,
    patientId,
    rejectionReason,
    rejectionCategory: rejectionCategory || "MISSING_DOCUMENT",
    recommendedActions: actions,
    appealLetter: letter,
    createdAt: new Date().toISOString(),
    status: "draft",
  };

  if (isDynamoEnabled()) {
    try {
      await getDocClient().send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: "APPEAL",
            SK: `APPEAL#${appeal.id}`,
            ...appeal,
          },
        })
      );
      return appeal;
    } catch (e) {
      console.warn("[DynamoDB] recordRejectionAndAppeal error, fallback to local:", e.message);
    }
  }

  const appeals = await readJson(APPEALS_PATH);
  appeals.unshift(appeal);
  await writeJson(APPEALS_PATH, appeals);
  return appeal;
}

async function getAppeals() {
  let dynamoItems = [];
  if (isDynamoEnabled()) {
    try {
      const res = await getDocClient().send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "APPEAL" },
        })
      );
      dynamoItems = res.Items || [];
    } catch (e) {
      console.warn("[DynamoDB] getAppeals error, fallback to local:", e.message);
    }
  }

  const localList = await readJson(APPEALS_PATH);
  if (dynamoItems.length === 0) return localList;
  const seenIds = new Set(dynamoItems.map((d) => d.id));
  return [...dynamoItems, ...localList.filter((l) => !seenIds.has(l.id))];
}

// ─── Insurer Responses (Mock / Simulation) ──────────────────────────────────
async function getInsurerResponses() {
  const data = await readJson(INSURER_RESPONSES_PATH);
  return Array.isArray(data) ? data : [];
}

async function getInsurerResponseByClaimId(claimId) {
  const list = await getInsurerResponses();
  return list.find((r) => r.claimId === claimId);
}

async function saveInsurerResponse(record) {
  const list = await getInsurerResponses();
  const idx = list.findIndex((r) => r.claimId === record.claimId);
  const entry = {
    claimId: record.claimId,
    patientId: record.patientId || "Unknown",
    status: record.status || "pending",
    rejectionReason: record.rejectionReason || null,
    rejectionCategory: record.rejectionCategory || "MISSING_DOCUMENT",
    receivedAt: record.receivedAt || new Date().toISOString(),
    processedAt: record.processedAt || null,
    appealId: record.appealId || null,
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.unshift(entry);
  await writeJson(INSURER_RESPONSES_PATH, list);
  return entry;
}

async function getHistoricalRejectionTemplates() {
  try {
    const data = await fs.readFile(HISTORICAL_REJECTIONS_PATH, "utf-8");
    const parsed = JSON.parse(data);
    const log = parsed.rejection_log || parsed;
    return Array.isArray(log) ? log : [];
  } catch (e) {
    return [];
  }
}

async function runRejectionMonitor(options = {}) {
  const { simulateRejectionRate = 0.15 } = options;
  const submitted = await getSubmittedClaims();
  const responses = await getInsurerResponses();
  const byClaim = new Map(responses.map((r) => [r.claimId, r]));
  const templates = await getHistoricalRejectionTemplates();
  const newRejections = [];
  const newAppeals = [];

  for (const claim of submitted) {
    const claimId = claim.id || claim.claimId;
    if (!claimId) continue;
    if (byClaim.has(claimId)) continue;

    const isRejection = Math.random() < simulateRejectionRate;
    const status = isRejection ? "rejected" : "approved";
    const template = templates[Math.floor(Math.random() * templates.length)] || {};
    const rejectionReason = isRejection ? template.rejection_reason || "Documentation incomplete" : null;
    const rejectionCategory = isRejection ? template.rejection_category || "MISSING_DOCUMENT" : null;

    await saveInsurerResponse({
      claimId,
      patientId: claim.patientId || "Unknown",
      status,
      rejectionReason,
      rejectionCategory,
      receivedAt: new Date().toISOString(),
    });
    byClaim.set(claimId, { status, rejectionReason, rejectionCategory });

    if (isRejection) {
      newRejections.push({ claimId, patientId: claim.patientId, rejectionReason, rejectionCategory });
      const appeal = await recordRejectionAndAppeal(
        claimId,
        claim.patientId || "Unknown",
        rejectionReason,
        rejectionCategory
      );
      newAppeals.push(appeal);
      await saveInsurerResponse({
        claimId,
        patientId: claim.patientId,
        status: "rejected",
        rejectionReason,
        rejectionCategory,
        processedAt: new Date().toISOString(),
        appealId: appeal.id,
      });
    }
  }

  return {
    checked: submitted.length,
    newRejections,
    newAppeals,
  };
}

module.exports = {
  appendSubmittedClaim,
  getSubmittedClaims,
  notifyDoctor,
  getDoctorAlerts,
  mapRejectionToActions,
  draftAppealLetter,
  recordRejectionAndAppeal,
  getAppeals,
  getInsurerResponses,
  getInsurerResponseByClaimId,
  saveInsurerResponse,
  runRejectionMonitor,
};
