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
