SHELL := /bin/bash
ROOT_DIR:=$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))
VENV_PRE_COMMIT := ${ROOT_DIR}/venv/.pre_commit

.PHONY: all
all: ${VENV_PRE_COMMIT}

.PHONY: py
py: ${VENV_PYTHON_PACKAGES}
	bash -c 'source venv/bin/activate'

VENV_INITIALIZED := venv/.initialized

${VENV_INITIALIZED}:
	rm -rf venv && python3 -m venv venv
	@touch ${VENV_INITIALIZED}

VENV_PYTHON_PACKAGES := venv/.python_packages

${VENV_PYTHON_PACKAGES}: ${VENV_INITIALIZED}
	bash -c 'source venv/bin/activate && python -m pip install --upgrade pip setuptools build twine'
	bash -c 'source venv/bin/activate && python -m pip install -e .[dev]'
	@touch $@

${VENV_PRE_COMMIT}: ${VENV_PYTHON_PACKAGES}
	bash -c 'source venv/bin/activate && pre-commit install'
	@touch $@

develop: ${VENV_PRE_COMMIT}
	@echo "--\nRun "source env.sh" to enter development mode!"

fixup:
	pre-commit run --all-files

.PHONY: test test-py test-js build build-py test-py publish publish-py publish-js clean docs

test: test-py test-js

test-py:
	source env.sh && python3 -m pytest

test-js:
	npm run test

build: build-py build-js

build-py:
	./scripts/prepare_readme.py py
	source env.sh && python3 -m build --outdir pydist
	git checkout README.md

build-js:
	npm run build

publish: publish-py publish-js

publish-py: build-py
	source env.sh && python3 -m twine upload pydist/autoevals-${SDK_VERSION}*

publish-js: build-js
	npm publish

clean:
	source env.sh && rm -rf pydist/* jsdist/*
