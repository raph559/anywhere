#!/bin/sh
# Print a new random secret and the SHA-256 hash the hub configuration expects.
# Use it for the browser access key ("loginTokenHash") and for each device ("tokenHash").
set -eu
secret=$(openssl rand -base64 36 | tr -d '=+/' | cut -c1-40)
printf 'secret: %s\nhash:   %s\n' "$secret" "$(printf '%s' "$secret" | sha256sum | cut -d' ' -f1)"
