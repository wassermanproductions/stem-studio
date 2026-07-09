###
# Vendored from TIGER (https://github.com/JusperLee/TIGER), look2hear/models/base_model.py
# Author: Kai Li — MIT License (see LICENSE in this directory).
#
# Trimmed for Stem Studio: only the pieces TIGERDNR needs to load from the
# Hugging Face Hub (PyTorchModelHubMixin) are kept. The `serialize()` method
# and its `pytorch_lightning` import were removed — they are training-only and
# pull a heavy dependency we do not want at inference time.
###
import torch
import torch.nn as nn
from huggingface_hub import PyTorchModelHubMixin


class BaseModel(
    nn.Module,
    PyTorchModelHubMixin,
    repo_url="https://github.com/JusperLee/TIGER",
    pipeline_tag="audio-to-audio",
):
    def __init__(self, sample_rate, in_chan=1):
        super().__init__()
        self._sample_rate = sample_rate
        self._in_chan = in_chan

    def forward(self, *args, **kwargs):
        raise NotImplementedError

    def sample_rate(self):
        return self._sample_rate

    def get_state_dict(self):
        """In case the state dict needs to be modified before sharing the model."""
        return self.state_dict()

    def get_model_args(self):
        """Should return args to re-instantiate the class."""
        raise NotImplementedError
