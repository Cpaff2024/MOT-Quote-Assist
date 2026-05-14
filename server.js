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

function cleanRegistration(registration) {
  return String(registration || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function formatDate(value) {
  if (!value) return "Unknown";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

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
  } catch (error) {
    console.error(`\n${label} returned non-JSON:`);
    console.error(rawText.slice(0, 1000));

    throw new Error(
      `${label} returned HTML/text instead of JSON. Check the URL, credentials and API setup.`
    );
  }
}

async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE;

  if (!tokenUrl || !clientId || !clientSecret || !scope) {
    throw new Error(
      "Missing DVSA OAuth details in .env. Check DVSA_TOKEN_URL, DVSA_CLIENT_ID, DVSA_CLIENT_SECRET and DVSA_SCOPE."
    );
  }

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", clientId);
  body.append("client_secret", clientSecret);
  body.append("scope", scope);

  console.log("\nRequesting DVSA access token...");

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
    console.error("\nDVSA token error:");
    console.error(data);

    throw new Error(
      data?.error_description ||
        data?.error ||
        "Could not get DVSA access token. Check token URL, client ID, secret and scope."
    );
  }

  if (!data.access_token) {
    console.error("\nDVSA token response did not contain access_token:");
    console.error(data);

    throw new Error("DVSA token response did not contain an access token.");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;

  console.log("DVSA access token received.");

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
      return res.status(400).json({
        error: "Registration is required."
      });
    }

    const apiKey = process.env.DVSA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing DVSA_API_KEY in .env file."
      });
    }

    const accessToken = await getAccessToken();

    const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(
      registration
    )}`;

    console.log(`\nLooking up MOT history for: ${registration}`);
    console.log(`DVSA URL: ${url}`);

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
      console.error("\nDVSA MOT lookup error:");
      console.error(data);

      return res.status(response.status).json({
        error: data?.message || data?.error || "DVSA lookup failed.",
        detail: data
      });
    }

    const vehicle = normaliseVehicleData(data);

    res.json(vehicle);
  } catch (error) {
    console.error("\nServer error:");
    console.error(error);

    res.status(500).json({
      error: error.message || "Something went wrong."
    });
  }
});

app.listen(PORT, () => {
  console.log(`\nMOT Quote Assist running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});