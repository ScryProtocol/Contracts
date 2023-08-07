.PHONY: build-docker
build-docker:
	(docker build . -t scryprotocol/morpheus:latest)
