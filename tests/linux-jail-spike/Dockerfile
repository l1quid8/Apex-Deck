FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y -qq bubblewrap python3 curl ca-certificates git nodejs npm >/dev/null
RUN npm install -g --silent @anthropic-ai/claude-code @openai/codex @google/gemini-cli
RUN useradd -m tester
