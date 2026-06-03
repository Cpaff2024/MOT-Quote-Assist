require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let cachedToken = null;
let tokenExpiresAt = 0;

function cleanValue(value) {
  return String(value || "").trim();
}

function cleanRegistration(registration) {
  return String(registration || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function cleanPartNumber(partNumber) {
  return String(partNumber || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

async function readJsonResponse(response, label) {
  const rawText = await response.text();

  try {
    return JSON.parse(rawText);
  } catch {
    console.error(`\n${label} returned non-JSON:`);
    console.error(rawText.slice(0, 1000));
    throw new Error(`${label} returned HTML/text instead of JSON.`);
  }
}

async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE;

  if (!tokenUrl || !clientId || !clientSecret || !scope) {
    throw new Error("Missing DVSA OAuth details in environment variables.");
  }

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", clientId);
  body.append("client_secret", clientSecret);
  body.append("scope", scope);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  const data = await readJsonResponse(response, "DVSA token endpoint");

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
        data?.error ||
        "Could not get DVSA access token."
    );
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;

  return cachedToken;
}

function normaliseVehicleData(vehicle) {
  const motTests = Array.isArray(vehicle.motTests) ? vehicle.motTests : [];

  const sortedTests = [...motTests].sort((a, b) => {
    return new Date(b.completedDate || 0) - new Date(a.completedDate || 0);
  });

  const latestMot = sortedTests[0] || null;
  const defects =
    latestMot && Array.isArray(latestMot.defects) ? latestMot.defects : [];

  const failures = defects
    .filter((defect) => {
      const type = String(defect.type || "").toLowerCase();
      const text = String(defect.text || "").toLowerCase();

      return (
        type.includes("fail") ||
        type.includes("major") ||
        type.includes("dangerous") ||
        text.includes("dangerous") ||
        text.includes("major")
      );
    })
    .map((defect) => defect.text)
    .filter(Boolean);

  const advisories = defects
    .filter((defect) => {
      const type = String(defect.type || "").toLowerCase();
      return type.includes("advisory") || type.includes("minor");
    })
    .map((defect) => defect.text)
    .filter(Boolean);

  return {
    registration: vehicle.registration || "",
    make: vehicle.make || "Unknown make",
    model: vehicle.model || "",
    fuelType: vehicle.fuelType || "Unknown",
    engineSize: vehicle.engineSize ? `${vehicle.engineSize}cc` : "Unknown",
    colour: vehicle.primaryColour || "Unknown",
    motTestDueDate: vehicle.motTestDueDate || "",
    hasOutstandingRecall: vehicle.hasOutstandingRecall || "Unknown",
    mot: latestMot
      ? {
          date: formatDate(latestMot.completedDate),
          rawDate: latestMot.completedDate || "",
          result: latestMot.testResult || "Unknown",
          expiry: formatDate(latestMot.expiryDate || vehicle.motTestDueDate),
          mileage: latestMot.odometerValue
            ? `${latestMot.odometerValue} ${
                latestMot.odometerUnit || ""
              }`.trim()
            : "Unknown",
          failures,
          advisories
        }
      : {
          date: "No MOT found",
          rawDate: "",
          result: "Unknown",
          expiry: formatDate(vehicle.motTestDueDate),
          mileage: "Unknown",
          failures: [],
          advisories: []
        }
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "MOT Quote Assist backend is running."
  });
});

app.get("/api/mot/:registration", async (req, res) => {
  try {
    const registration = cleanRegistration(req.params.registration);

    if (!registration) {
      return res.status(400).json({ error: "Registration is required." });
    }

    const apiKey = process.env.DVSA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "Missing DVSA_API_KEY." });
    }

    const accessToken = await getAccessToken();

    const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(
      registration
    )}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-API-Key": apiKey,
        Accept: "application/json"
      }
    });

    const data = await readJsonResponse(response, "DVSA MOT endpoint");

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || data?.error || "DVSA lookup failed.",
        detail: data
      });
    }

    res.json(normaliseVehicleData(data));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Something went wrong." });
  }
});

app.get("/api/xref/:vwPartNumber", async (req, res) => {
  try {
    const webAppUrl = process.env.XREF_SHEET_WEBAPP_URL;
    const secret = process.env.XREF_SHEET_SECRET;
    const vwPartNumber = cleanPartNumber(req.params.vwPartNumber);

    if (!webAppUrl || !secret) {
      return res.status(500).json({
        error: "Missing Google Sheet x-ref environment variables."
      });
    }

    if (!vwPartNumber) {
      return res.status(400).json({ error: "VW part number is required." });
    }

    const url = `${webAppUrl}?secret=${encodeURIComponent(
      secret
    )}&vwPartNumber=${encodeURIComponent(vwPartNumber)}`;

    const response = await fetch(url);
    const data = await readJsonResponse(response, "Google Sheet x-ref lookup");

    if (!data.success) {
      return res.status(500).json({
        error: data.error || "Google Sheet lookup failed."
      });
    }

    res.json({
      success: true,
      matches: data.matches || []
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "X-ref lookup failed." });
  }
});

app.post("/api/xref", async (req, res) => {
  try {
    const webAppUrl = process.env.XREF_SHEET_WEBAPP_URL;
    const secret = process.env.XREF_SHEET_SECRET;

    if (!webAppUrl || !secret) {
      return res.status(500).json({
        error: "Missing Google Sheet x-ref environment variables."
      });
    }

    const payload = {
      secret,
      vwPartNumber: cleanPartNumber(req.body.vwPartNumber),
      supplier: cleanValue(req.body.supplier),
      aftermarketPartNumber: cleanValue(req.body.aftermarketPartNumber).toUpperCase(),
      category: cleanValue(req.body.category),
      submittedBy: cleanValue(req.body.submittedBy),
      notes: cleanValue(req.body.notes)
    };

    if (!payload.vwPartNumber || !payload.supplier || !payload.aftermarketPartNumber) {
      return res.status(400).json({
        error: "VW part number, supplier and aftermarket part number are required."
      });
    }

    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    const data = await readJsonResponse(response, "Google Sheet x-ref save");

    if (!data.success) {
      return res.status(500).json({
        error: data.error || "Could not save match."
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not save match." });
  }
});

app.listen(PORT, () => {
  console.log(`MOT Quote Assist running on port ${PORT}`);
});