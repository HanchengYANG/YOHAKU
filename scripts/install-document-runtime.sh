#!/usr/bin/env bash
# Install PDF/EPUB parsing, offline ruby and NDLOCR CPU inference in local venvs.
set -euo pipefail
DOCUMENT_PROJECT=$(cd "$(dirname "$0")/.." && pwd)
DOCUMENT_BOOTSTRAP_PYTHON=${DOCUMENT_BOOTSTRAP_PYTHON:-python3}
install_document_packages() {
  local runtime_python=$1
  shift
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$runtime_python" "$@"
  else
    "$runtime_python" -m pip install --disable-pip-version-check "$@"
  fi
}
"$DOCUMENT_BOOTSTRAP_PYTHON" -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'
if ! "$DOCUMENT_BOOTSTRAP_PYTHON" -m venv --help >/dev/null 2>&1; then
  echo 'Install Python venv first: sudo apt-get install python3-venv python3-pip git' >&2
  exit 1
fi
command -v git >/dev/null || { echo 'Install git before installing the pinned NDLOCR-Lite source.' >&2; exit 1; }
"$DOCUMENT_BOOTSTRAP_PYTHON" -m venv "$DOCUMENT_PROJECT/.venv-documents"
install_document_packages "$DOCUMENT_PROJECT/.venv-documents/bin/python" \
  -r "$DOCUMENT_PROJECT/scripts/document-requirements.txt" -r "$DOCUMENT_PROJECT/scripts/ruby-requirements.txt"
"$DOCUMENT_PROJECT/.venv-documents/bin/python" - "$DOCUMENT_PROJECT/server/ocr/ruby-worker.py" <<'PY'
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('local_ruby_install_check', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
result = worker.annotate('何を食べる？')
assert any(item['surface'] == '食' and item['reading'] == 'た' for item in result['annotations'])
assert any(item['surface'] == '何' and item['reading'] == 'なに' for item in result['annotations'])
print('Offline Japanese ruby CPU dependencies are ready.')
PY
"$DOCUMENT_BOOTSTRAP_PYTHON" -m venv "$DOCUMENT_PROJECT/.venv-ndlocr"
install_document_packages "$DOCUMENT_PROJECT/.venv-ndlocr/bin/python" -r "$DOCUMENT_PROJECT/scripts/ocr-requirements.txt"
# Include the official packaged ONNX weights and configuration. The web server
# performs no downloads or provider authorization while running local OCR.
install_document_packages "$DOCUMENT_PROJECT/.venv-ndlocr/bin/python" --no-deps \
  'ndlocr-lite @ git+https://github.com/ndl-lab/ndlocr-lite.git@e57f7c6bd9cfb3de5f12f008e71ad2122bd44bfd'
"$DOCUMENT_PROJECT/.venv-ndlocr/bin/python" - <<'PY'
from pathlib import Path
import ocr
import onnxruntime
base = Path(ocr.__file__).resolve().parent
for name in ('deim-s-1024x1024.onnx',
             'parseq-ndl-24x256-30-tiny-189epoch-tegaki3-r8data-202604.onnx',
             'parseq-ndl-24x384-50-tiny-300epoch-tegaki3-r8data-202604.onnx',
             'parseq-ndl-24x768-100-tiny-153epoch-tegaki3-r8data-202604.onnx'):
    assert (base / 'model' / name).stat().st_size > 1_000_000, 'Missing ONNX model: ' + name
assert 'CPUExecutionProvider' in onnxruntime.get_available_providers()
print('Local document parsing and NDLOCR CPU dependencies are ready.')
PY
