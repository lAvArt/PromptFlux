import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import selfsigned from "selfsigned";

export interface MobileBridgeCertificate {
  key: string;
  cert: string;
  keyPath: string;
  certPath: string;
  generated: boolean;
}

function appDataDir(): string {
  return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
}

function certificateDirectory(): string {
  return path.join(appDataDir(), "promptflux", "certs");
}

function extractSubjectAltNameSets(cert: X509Certificate): { dns: Set<string>; ips: Set<string> } {
  const dns = new Set<string>();
  const ips = new Set<string>();
  const value = cert.subjectAltName ?? "";
  const matches = value.matchAll(/(DNS|IP Address):\s*([^,]+)/g);
  for (const match of matches) {
    const kind = String(match[1] ?? "");
    const host = String(match[2] ?? "").trim();
    if (!host) {
      continue;
    }
    if (kind === "DNS") {
      dns.add(host.toLowerCase());
      continue;
    }
    if (kind === "IP Address") {
      ips.add(host);
    }
  }
  return { dns, ips };
}

function normalizeHosts(hosts: string[]): { dns: string[]; ips: string[] } {
  const dns = new Set<string>();
  const ips = new Set<string>();

  dns.add("localhost");
  ips.add("127.0.0.1");
  ips.add("::1");

  for (const rawHost of hosts) {
    const host = String(rawHost ?? "").trim();
    if (!host || host === "0.0.0.0") {
      continue;
    }
    if (isIP(host)) {
      ips.add(host);
      continue;
    }
    dns.add(host.toLowerCase());
  }

  return {
    dns: Array.from(dns),
    ips: Array.from(ips),
  };
}

function certificateNeedsRotation(certPem: string, hosts: string[]): boolean {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return true;
  }

  const expiry = Date.parse(cert.validTo);
  if (!Number.isFinite(expiry)) {
    return true;
  }
  const sevenDaysFromNow = Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (expiry <= sevenDaysFromNow) {
    return true;
  }

  const required = normalizeHosts(hosts);
  const present = extractSubjectAltNameSets(cert);
  for (const dnsEntry of required.dns) {
    if (!present.dns.has(dnsEntry)) {
      return true;
    }
  }
  for (const ipEntry of required.ips) {
    if (!present.ips.has(ipEntry)) {
      return true;
    }
  }
  return false;
}

function generateCertificate(hosts: string[]): { key: string; cert: string } {
  const normalized = normalizeHosts(hosts);
  const altNames = [
    ...normalized.dns.map((value) => ({ type: 2 as const, value })),
    ...normalized.ips.map((ip) => ({ type: 7 as const, ip })),
  ];

  const pems = selfsigned.generate(
    [
      { name: "commonName", value: "PromptFlux Mobile Bridge" },
      { name: "organizationName", value: "PromptFlux" },
    ],
    {
      algorithm: "sha256",
      keySize: 2048,
      days: 3650,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    },
  );

  return {
    key: pems.private,
    cert: pems.cert,
  };
}

export function ensureMobileBridgeCertificate(hosts: string[]): MobileBridgeCertificate {
  const certDir = certificateDirectory();
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, "mobile-bridge.key.pem");
  const certPath = path.join(certDir, "mobile-bridge.cert.pem");

  let key = "";
  let cert = "";
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    key = fs.readFileSync(keyPath, "utf8");
    cert = fs.readFileSync(certPath, "utf8");
  }

  const hasExisting = key.trim().length > 0 && cert.trim().length > 0;
  const rotate = !hasExisting || certificateNeedsRotation(cert, hosts);
  if (rotate) {
    const generated = generateCertificate(hosts);
    key = generated.key;
    cert = generated.cert;
    fs.writeFileSync(keyPath, key, "utf8");
    fs.writeFileSync(certPath, cert, "utf8");
  }

  return {
    key,
    cert,
    keyPath,
    certPath,
    generated: rotate,
  };
}
