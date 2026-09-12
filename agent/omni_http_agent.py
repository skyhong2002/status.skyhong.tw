#!/usr/bin/env python3
"""Probe OmniObserve from SkyLabMac and report through the existing agent channel."""
import concurrent.futures,json,subprocess,urllib.request
from pathlib import Path

def probe(target):
    result=subprocess.run(['/usr/bin/curl','--silent','--show-error','--location','--output','/dev/null','--write-out','%{http_code} %{time_total}','--max-time','10',target['checkUrl']],capture_output=True,text=True,timeout=13)
    parts=result.stdout.split();code=int(parts[0]) if parts and parts[0].isdigit() else 0
    latency=round(float(parts[1])*1000) if len(parts)>1 else 10000
    return {'id':target['id'],'name':target['name'],'kind':'HTTP probe','up':result.returncode==0 and code==200,'statusCode':code or None,'latencyMs':latency,'detail':f'HTTP {code}' if code else 'Connection failed from SkyLabMac'}

def main():
    config=json.loads((Path.home()/'.config/sky-status-agent.json').read_text())
    targets=json.loads(Path(__file__).with_name('omni-targets.json').read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:items=list(pool.map(probe,targets))
    req=urllib.request.Request(config['endpoint'].rstrip('/')+'/api/agents/omni-probe',data=json.dumps({'host':'SkyLabMac','items':items}).encode(),headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=15) as response:assert response.status==200
    print(f'OmniObserve probes: {sum(x["up"] for x in items)}/{len(items)} up')
if __name__=='__main__':main()
