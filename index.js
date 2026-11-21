const fs = require("fs");
const path = require("path");

const CLOUDFLARE_GATEWAY_URL = (process.env.CLOUDFLARE_GATEWAY_URL || "").replace(/\/+$/, "");
const GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || "";
const GITHUB_OWNER = process.env.GITHUB_REPOSITORY_OWNER || "";
const DISPATCH_TOKEN = process.env.DISPATCH_TOKEN || "";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

async function main() {
  if (!CLOUDFLARE_GATEWAY_URL) {
    throw new Error("Missing CLOUDFLARE_GATEWAY_URL environment variable.");
  }
  if (!GATEWAY_SECRET_KEY) {
    throw new Error("Missing GATEWAY_SECRET_KEY environment variable.");
  }
  if (!DISPATCH_TOKEN) {
    throw new Error("Missing DISPATCH_TOKEN environment variable.");
  }

  const routesPath = path.join(__dirname, "routes.json");
  const parsedConfig = JSON.parse(fs.readFileSync(routesPath, "utf8"));
  const routes = Array.isArray(parsedConfig.routes) ? parsedConfig.routes : [];

  const currentEpochMinute = Math.floor(Date.now() / 60000);
  const dueRoutes = routes.filter(route => {
    if (!route || !route.enabled) return false;
    const interval = Math.max(1, Number(route.intervalMinutes || 1));
    const offset = Math.max(0, Number(route.offsetMinutes || 0));
    return (currentEpochMinute + offset) % interval === 0;
  });

  if (dueRoutes.length === 0) {
    console.log(`Epoch minute ${currentEpochMinute}: no routes due.`);
    return;
  }

  const outcomes = await Promise.allSettled(
    dueRoutes.map(route => dispatchWorkflowViaGateway(route))
  );

  for (let i = 0; i < outcomes.length; i++) {
    const route = dueRoutes[i];
    const outcome = outcomes[i];
    if (outcome.status === "fulfilled") {
      console.log(`Dispatched ${route.id} (${route.repo}/${route.workflow}).`);
    } else {
      console.warn(`Failed to dispatch ${route.id}: ${outcome.reason.message}`);
    }
  }
}

async function dispatchWorkflowViaGateway(route) {
  const owner = route.owner || GITHUB_OWNER;
  const repo = route.repo;
  const workflow = route.workflow || "execute.yml";
  const ref = route.ref || "main";

  const url = `${CLOUDFLARE_GATEWAY_URL}/github/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DISPATCH_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "Automation-Router/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
          "X-Gateway-Key": GATEWAY_SECRET_KEY
        },
        body: JSON.stringify({ ref: ref })
      });

      if (response.ok) {
        return;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      if (attempt >= MAX_RETRY_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(`Router fatal error: ${error.message}`);
  process.exit(1);
});
