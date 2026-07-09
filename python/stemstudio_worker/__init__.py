"""Stem Studio Python worker.

Separates a married soundtrack WAV into dialogue/music/effects stems. The CLI
entry point lives in ``separate.py``; the actual separation is provided by an
``Engine`` (see ``separate.Engine``). ``engine_stub.py`` is a dependency-light
band-split placeholder; a real ML engine can be dropped in behind the same
protocol later.
"""

__version__ = "1.0.0"
