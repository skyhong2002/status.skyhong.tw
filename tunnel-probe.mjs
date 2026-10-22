import https from 'node:https';
export function fetchThroughSocket(url, socketPath, signal) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Tunnel requires HTTPS');
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {socketPath, servername: parsed.hostname,
      rejectUnauthorized: true, signal}, (response) => {
      const chunks=[]; let size=0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2097152) { response.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({status:response.statusCode, statusText:response.statusMessage,
        text:async()=>Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error', reject);
  });
}

// Return only allowlisted diagnostics; error messages can contain private URLs.
export function describeTunnelError(error) {
  const code = error?.code || error?.cause?.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || code === 'ETIMEDOUT') {
    return 'Private SSH tunnel timed out';
  }
  const reasons = {
    ECONNREFUSED: 'Private SSH tunnel has no listener (ECONNREFUSED)',
    ENOENT: 'Private SSH tunnel socket missing (ENOENT)',
    EACCES: 'Private SSH tunnel socket permission denied (EACCES)',
    EPERM: 'Private SSH tunnel socket permission denied (EPERM)',
    ECONNRESET: 'Private SSH tunnel closed before HTTPS response (ECONNRESET)',
    EPIPE: 'Private SSH tunnel closed before HTTPS response (EPIPE)',
  };
  if (Object.hasOwn(reasons, code)) return reasons[code];
  const tlsCodes = new Set([
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ]);
  if (tlsCodes.has(code)) return `Private SSH tunnel TLS validation failed (${code})`;
  return 'Private SSH tunnel unavailable';
}

export function tunnelTransportDetail(targets) {
  const failures = targets.filter((target) => target.id.startsWith('omni-') && !target.up);
  const reasons = [...new Set(failures.map((target) => target.detail))];
  return 'Active monitor transport: private SSH tunnel' + (reasons.length ? ` · ${reasons.join('; ')}` : '');
}
