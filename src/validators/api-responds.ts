import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.internal.',
]);

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || METADATA_HOSTS.has(normalized);
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }

  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIPv4(address);
  }
  if (family === 6) {
    return isPrivateIPv6(address);
  }
  return false;
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) {
    return [hostname];
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

async function blocksServerSideRequest(hostname: string): Promise<boolean> {
  if (isBlockedHostname(hostname)) {
    return true;
  }

  const addresses = await resolveAddresses(hostname);
  return addresses.some((address) => isPrivateAddress(address));
}

export class ApiRespondsValidator implements Validator {
  type = 'api_responds';

  async validate(
    config: Record<string, unknown>,
    _context: ValidatorContext,
  ): Promise<ValidationResult> {
    const url = config.url as string;
    const expectedStatus = config.status as number;
    const bodyContains = config.body_contains as string | undefined;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        type: this.type,
        target: url,
        passed: false,
        details: `Invalid URL: ${url}`,
        optional: config.optional as boolean | undefined,
      };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        type: this.type,
        target: url,
        passed: false,
        details: `Unsupported URL scheme: ${parsedUrl.protocol} — only http: and https: are allowed`,
        optional: config.optional as boolean | undefined,
      };
    }

    if (await blocksServerSideRequest(parsedUrl.hostname)) {
      return {
        type: this.type,
        target: url,
        passed: false,
        details: `Blocked potential SSRF target: ${parsedUrl.hostname}`,
        optional: config.optional as boolean | undefined,
      };
    }

    const timeoutSec = (config.timeout as number | undefined) ?? 30;
    const timeoutMs = timeoutSec * 1000 || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const startTime = Date.now();
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
      });

      let bodyMatched = true;
      if (bodyContains !== undefined) {
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            totalBytes += value.byteLength;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              return {
                type: this.type,
                target: url,
                passed: false,
                details: `Response body exceeds ${MAX_RESPONSE_BYTES} bytes limit`,
                duration_ms: Date.now() - startTime,
                optional: config.optional as boolean | undefined,
              };
            }

            chunks.push(value);
          }

          const bodyText = new TextDecoder().decode(Buffer.concat(chunks));
          bodyMatched = bodyText.includes(bodyContains);
        } else {
          const bodyText = await response.text();
          bodyMatched = bodyText.includes(bodyContains);
        }
      }

      const durationMs = Date.now() - startTime;
      const statusMatched = response.status === expectedStatus;
      const passed = statusMatched && bodyMatched;

      const reasons: string[] = [];
      if (!statusMatched) {
        reasons.push(`Expected status ${expectedStatus}, got ${response.status}`);
      }
      if (!bodyMatched) {
        reasons.push(`Response body does not contain: ${JSON.stringify(bodyContains)}`);
      }

      return {
        type: this.type,
        target: url,
        passed,
        duration_ms: durationMs,
        details: passed ? undefined : reasons.join('; '),
        optional: config.optional as boolean | undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      return {
        type: this.type,
        target: url,
        passed: false,
        details: isTimeout
          ? `Request timed out after ${timeoutSec}s`
          : `Error making HTTP request: ${message}`,
        optional: config.optional as boolean | undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
