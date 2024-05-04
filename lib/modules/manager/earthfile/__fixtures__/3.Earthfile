 ARG \
	# multi-line arg
  --global \
   ALPINE_VERSION=alpine:3.15.4

stage1:
  FROM \
  ${ALPINE_VERSION}

stage2:
  ARG   \
      \
    # multi-line arg
    # and multi-line comment
      nginx_version="nginx:1.18.0-alpine@sha256:ca9fac83c6c89a09424279de522214e865e322187b22a1a29b12747a4287b7bd"
  FROM $nginx_version
