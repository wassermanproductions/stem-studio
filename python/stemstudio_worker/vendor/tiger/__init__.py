"""Minimal vendored TIGER-DnR model code.

Vendored from https://github.com/JusperLee/TIGER (MIT License, Author: Kai Li).
Only the modules TIGERDNR needs at inference time are included:

* ``tiger_dnr.py``       — the TIGER / TIGERDNR nn.Modules
* ``base_model.py``      — BaseModel + PyTorchModelHubMixin (training-only
                           ``serialize`` and its pytorch_lightning import removed)
* ``layers/activations.py``, ``layers/normalizations.py`` — the layer factories
                           referenced by the model

Weights are the Apache-2.0 ``JusperLee/TIGER-DnR`` checkpoint, downloaded from
the Hugging Face Hub at runtime (not vendored). See ../../.. NOTICE.

``TIGERDNR.from_pretrained("JusperLee/TIGER-DnR", cache_dir=...)`` loads the
model via the standard ``PyTorchModelHubMixin``.
"""

from .tiger_dnr import TIGER, TIGERDNR

__all__ = ["TIGER", "TIGERDNR"]
