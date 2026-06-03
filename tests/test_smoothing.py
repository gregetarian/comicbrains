"""Guard the smooth+ control: it must move the smooth-mesh vertices (more than the old
volume-locked Taubin), scale with the iteration count, restore at 0, and preserve aValue."""
import functools, http.server, socketserver, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent / "glass_brains" / "web"


def _disp(pg, iters):
    return pg.evaluate("""(iters)=>{
      const e=window.__engine();
      const t=e.sceneModel.meshes.find(m=>m.meta.role==='voxel'&&m.meta.variant==='smooth'&&(m.meta.overlay??0)===0);
      (e.config.style.overlays[0]||={}); (e.config.style.overlays[0].voxel||={}).smoothing=iters; e.applySmoothing(0);
      const o=t.mesh.geometry.userData.gbTopo.orig, a=t.mesh.geometry.attributes.position.array;
      const v=t.mesh.geometry.getAttribute('aValue').array;
      let maxd=0,n=o.length/3;
      for(let i=0;i<n;i++){const d=Math.hypot(a[3*i]-o[3*i],a[3*i+1]-o[3*i+1],a[3*i+2]-o[3*i+2]); if(d>maxd)maxd=d;}
      return {maxDisp:maxd, val0:v[0], nverts:n};
    }""", iters)


def main():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), h)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    errs = []; ok = True
    def check(n, c):
        nonlocal ok; ok &= bool(c); print(f"  {'OK ' if c else 'BAD'} {n}")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        pg = b.new_page(viewport={"width": 1400, "height": 900})
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append("PAGEERR " + str(e)))
        pg.goto(f"http://127.0.0.1:{port}/index.html")
        pg.wait_for_function("window.__engine && window.__engine() && window.__engine().overlays.length>=1", timeout=60000)
        pg.wait_for_timeout(400)
        d0 = _disp(pg, 0); dlo = _disp(pg, 5); dhi = _disp(pg, 20)
        check("smoothing=0 leaves geometry at original", d0["maxDisp"] < 1e-4)
        check("smoothing moves vertices (beyond the old ~0.3mm Taubin no-op)", dhi["maxDisp"] > 0.4)
        check("more iterations smooth more", dhi["maxDisp"] > dlo["maxDisp"] > 1e-3)
        check("aValue preserved (threshold/cluster intact)", dhi["val0"] == d0["val0"])
        back = _disp(pg, 0)
        check("non-cumulative (0 restores original)", back["maxDisp"] < 1e-4)
        b.close()
    httpd.shutdown()
    bad = [e for e in errs if "favicon" not in e.lower()]
    if bad: print("ERRORS:", *bad[:6], sep="\n  - ")
    ok = ok and not bad
    print("\n" + ("PASS — smooth+ smooths (size-preserving), scales, restores, no errors" if ok else "FAIL"))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
