"""Local HTTP server with overlay upload API + browser launch."""

import http.server
import json
import tempfile
import webbrowser
import threading
from pathlib import Path


class GlassBrainHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files + handles POST /api/load-overlay for NIfTI upload."""

    # Set by serve_and_open
    export_dir = None
    glass_brain = None

    def do_POST(self):
        routes = {'/api/load-overlay': self._handle_load_overlay,
                  '/api/remove-overlay': self._handle_remove_overlay}
        handler = routes.get(self.path)
        if handler is None:
            self.send_error(404)
            return
        try:
            handler()
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': False, 'error': str(e)}).encode())

    def _json(self, payload, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def _reexport_overlays(self):
        """Rewrite GLB + sidecars + scene.json for ALL current overlays (index-prefixed)."""
        import shutil
        from .export import export_mesh
        gb = self.__class__.glass_brain
        export_dir = Path(self.__class__.export_dir)
        overlay_dir = export_dir / 'overlay'
        if overlay_dir.exists():
            shutil.rmtree(overlay_dir)
        overlay_dir.mkdir(parents=True, exist_ok=True)

        overlay_entries = []
        for i, ov in enumerate(gb.overlays):
            entry = {
                'name': ov['name'], 'colormap': ov['cmap'], 'threshold': ov['threshold'],
                'maxAbsValue': ov['max_abs_value'], 'maxClusterSize': ov.get('max_cluster', 0),
                'diverging': bool(ov['diverging']), 'role': 'overlay', 'structureOverlays': {},
            }
            for cat, so in ov['structure_overlays'].items():
                base = f"overlay/o{i}_{cat}"          # index-prefixed → unique across overlays
                export_mesh(so['mesh'], export_dir / f"{base}.glb")
                with open(export_dir / f"{base}_values.json", 'w') as f:
                    json.dump(so['values'], f)
                with open(export_dir / f"{base}_clusters.json", 'w') as f:
                    json.dump(so['clusters'], f)
                cat_entry = {'mesh': f"{base}.glb", 'values': f"{base}_values.json", 'clusters': f"{base}_clusters.json"}
                if 'mesh_smooth' in so:
                    export_mesh(so['mesh_smooth'], export_dir / f"{base}_smooth.glb")
                    with open(export_dir / f"{base}_smooth_values.json", 'w') as f:
                        json.dump(so['values_smooth'], f)
                    with open(export_dir / f"{base}_smooth_clusters.json", 'w') as f:
                        json.dump(so['clusters_smooth'], f)
                    cat_entry['meshSmooth'] = f"{base}_smooth.glb"
                    cat_entry['valuesSmooth'] = f"{base}_smooth_values.json"
                    cat_entry['clustersSmooth'] = f"{base}_smooth_clusters.json"
                entry['structureOverlays'][cat] = cat_entry
            overlay_entries.append(entry)

        scene_path = export_dir / 'scene.json'
        with open(scene_path) as f:
            scene = json.load(f)
        scene['overlays'] = overlay_entries
        with open(scene_path, 'w') as f:
            json.dump(scene, f, indent=2)
        return overlay_entries

    def _handle_remove_overlay(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b'{}'
        idx = int(json.loads(body or b'{}').get('index', -1))
        gb = self.__class__.glass_brain
        if 0 <= idx < len(gb.overlays):
            removed = gb.overlays.pop(idx)
            print(f"Removed overlay [{idx}]: {removed['name']}")
        entries = self._reexport_overlays()
        self._json({'ok': True, 'count': len(entries)})

    def _handle_load_overlay(self):
        # Read multipart form data (threshold, cmap, file)
        content_type = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))

        if 'multipart/form-data' in content_type:
            body = self.rfile.read(content_length)
            fields, file_data, file_name = _parse_multipart(body, content_type)
        else:
            self.send_error(400, 'Expected multipart/form-data')
            return

        threshold = float(fields.get('threshold', '0.05'))
        cmap = fields.get('cmap', 'matplotlib:coolwarm')
        name = fields.get('name', Path(file_name).stem.replace('.nii', ''))

        # Save uploaded file to temp, preserving original extension
        if '.nii.gz' in file_name:
            suffix = '.nii.gz'
        elif file_name.endswith('.gz'):
            suffix = '.nii.gz'
        else:
            suffix = '.nii'
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False, prefix='gb_')
        tmp.write(file_data)
        tmp.close()
        print(f"Saved upload to {tmp.name} ({len(file_data)} bytes)")

        gb = self.__class__.glass_brain

        # APPEND the new overlay (keep existing ones — multiple NIfTIs coexist),
        # then re-export every overlay's assets + scene.json.
        gb.add_overlay(tmp.name, threshold=threshold, cmap=cmap, name=name)
        entries = self._reexport_overlays()
        self._json({'ok': True, 'count': len(entries)})

        Path(tmp.name).unlink(missing_ok=True)
        print(f"Loaded overlay: {name} (threshold={threshold}, cmap={cmap}); now {len(entries)} overlays")

    def end_headers(self):
        # Dev server: never let the browser cache JS/HTML modules, so edits
        # show up on a plain refresh instead of needing a hard reload.
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        # Suppress routine GET logs, show POST logs
        if 'POST' in str(args):
            super().log_message(format, *args)


def _parse_multipart(body, content_type):
    """Minimal multipart/form-data parser. Returns fields dict, file bytes, filename."""
    boundary = content_type.split('boundary=')[1].strip()
    boundary = boundary.encode()

    fields = {}
    file_data = b''
    file_name = 'upload.nii.gz'

    parts = body.split(b'--' + boundary)
    for part in parts:
        if b'Content-Disposition' not in part:
            continue
        header, _, data = part.partition(b'\r\n\r\n')
        data = data.rstrip(b'\r\n--')
        header_str = header.decode('utf-8', errors='replace')

        # Extract field name
        name_match = None
        for token in header_str.split(';'):
            token = token.strip()
            if token.startswith('name='):
                name_match = token.split('=')[1].strip('"')
            if token.startswith('filename='):
                file_name = token.split('=')[1].strip('"')

        if 'filename=' in header_str:
            file_data = data
        elif name_match:
            fields[name_match] = data.decode('utf-8').strip()

    return fields, file_data, file_name


def serve_and_open(directory, port=8421, glass_brain=None):
    """Serve a directory over HTTP and open in the default browser."""
    directory = str(Path(directory).resolve())

    GlassBrainHandler.export_dir = directory
    GlassBrainHandler.glass_brain = glass_brain

    handler = lambda *args, **kwargs: GlassBrainHandler(
        *args, directory=directory, **kwargs
    )

    for attempt_port in range(port, port + 100):
        try:
            httpd = http.server.HTTPServer(("", attempt_port), handler)
            break
        except OSError:
            continue
    else:
        raise RuntimeError(f"No available port found near {port}")

    url = f"http://localhost:{attempt_port}"
    print(f"Serving Glass Brain viewer at {url}")
    print("Press Ctrl+C to stop.")

    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    httpd.serve_forever()
