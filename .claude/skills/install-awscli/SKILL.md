---
name: install-awscli
description: Install AWS CLI into the agent container runtime. Use when user wants AWS access in agent containers. Triggers on "install aws", "aws cli", "aws setup".
---

# Install AWS CLI to Agent Runtime

This skill installs the AWS CLI v2 into the NanoClaw agent container, giving agents access to the `aws` command in Bash.

## Phase 1: Update Dockerfile

Add `unzip` to the existing `apt-get install` line, then add AWS CLI v2 installation to `container/Dockerfile`. Detect architecture automatically:

```dockerfile
# Install AWS CLI v2 (architecture-aware)
RUN ARCH=$(uname -m) \
    && curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws
```

## Phase 2: Rebuild Container

```bash
./container/build.sh
```

If the build uses cached layers, prune first:

```bash
docker builder prune -f && ./container/build.sh
```

## Phase 3: Restart NanoClaw

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Send a message to the agent asking it to run `aws --version`.

## AWS Credentials

To give agents access to your AWS account, pass credentials into the container:

- **Environment variables**: Add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_DEFAULT_REGION` to the container environment in `src/container-runner.ts`
- **IAM role**: If running on EC2/ECS with an instance role, credentials are automatically available

## Files Modified

| File | Change |
|------|--------|
| `container/Dockerfile` | Added `unzip` package and AWS CLI v2 installation (architecture-aware: x86_64 or aarch64) |
