#!/bin/bash
cd "$(dirname "$0")/.."
source venv/bin/activate
python3 scripts/plot_jump.py
