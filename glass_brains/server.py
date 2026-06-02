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
        if self.path == '/api/load-overlay':
            try:
                self._handle_load_overlay()
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}).encode())
        else:
            self.send_error(404)

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
        export_dir = Path(self.__class__.export_dir)

        # Clear existing overlays and add new one
        gb.overlays.clear()
        gb.add_overlay(tmp.name, threshold=threshold, cmap=cmap, name=name)

        # Re-export overlay files (cortex/subcort already exported)
        import shutil
        import numpy as np
        from .overlays import build_structure_overlays, classify_overlay_voxels
        from .export import export_mesh, write_scene_json

        ov = gb.overlays[0]
        entry = {
            'name': ov['name'],
            'colormap': ov['cmap'],
            'threshold': ov['threshold'],
            'maxAbsValue': ov['max_abs_value'],
            'maxClusterSize': ov.get('max_cluster', 0),
            'diverging': bool(ov['diverging']),
            'role': 'overlay',
            'structureOverlays': {},
        }

        overlay_dir = export_dir / 'overlay'
        # Clean old overlay files
        if overlay_dir.exists():
            shutil.rmtree(overlay_dir)
        overlay_dir.mkdir(parents=True, exist_ok=True)

        for cat, so in ov['structure_overlays'].items():
            mesh_rel = f"overlay/{ov['name']}_{cat}.glb"
            vals_rel = f"overlay/{ov['name']}_{cat}_values.json"
            clu_rel = f"overlay/{ov['name']}_{cat}_clusters.json"
            export_mesh(so['mesh'], export_dir / mesh_rel)
            with open(export_dir / vals_rel, 'w') as f:
                json.dump(so['values'], f)
            with open(export_dir / clu_rel, 'w') as f:
                json.dump(so['clusters'], f)
            cat_entry = {'mesh': mesh_rel, 'values': vals_rel, 'clusters': clu_rel}
            if 'mesh_smooth' in so:
                smesh_rel = f"overlay/{ov['name']}_{cat}_smooth.glb"
                svals_rel = f"overlay/{ov['name']}_{cat}_smooth_values.json"
                sclu_rel = f"overlay/{ov['name']}_{cat}_smooth_clusters.json"
                export_mesh(so['mesh_smooth'], export_dir / smesh_rel)
                with open(export_dir / svals_rel, 'w') as f:
                    json.dump(so['values_smooth'], f)
                with open(export_dir / sclu_rel, 'w') as f:
                    json.dump(so['clusters_smooth'], f)
                cat_entry['meshSmooth'] = smesh_rel
                cat_entry['valuesSmooth'] = svals_rel
                cat_entry['clustersSmooth'] = sclu_rel
            entry['structureOverlays'][cat] = cat_entry

        # Update scene.json
        scene_path = export_dir / 'scene.json'
        with open(scene_path) as f:
            scene = json.load(f)
        scene['overlays'] = [entry]
        with open(scene_path, 'w') as f:
            json.dump(scene, f, indent=2)

        # Respond with the new overlay entry
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'overlay': entry}).encode())

        # Cleanup temp file
        Path(tmp.name).unlink(missing_ok=True)
        print(f"Loaded overlay: {name} (threshold={threshold}, cmap={cmap})")

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
