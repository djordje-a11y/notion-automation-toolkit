#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Generate a Notion handoff markdown file via Cursor Agent + Notion MCP.

Usage:
  scripts/notion-mcp-handoff.sh --ticket <notion-url-or-id> [options]

Options:
  --ticket <value>      Notion page URL or page ID (required)
  --workspace <path>    Target workspace (default: current directory)
  --output <path>       Handoff output file path (default: notion-handoff.md in workspace)
  --agent-bin <path>    Path to cursor-agent binary (default: auto-detect)
  --model <id>          Model for cursor-agent (default: NOTION_MCP_HANDOFF_MODEL or NOTION_AGENT_MODEL or composer-2.5)
  --model inherit       Skip --model injection (use cursor-agent session default)
  -h, --help            Show this help
EOF
}

ticket=""
workspace="${PWD}"
output_rel="notion-handoff.md"
agent_bin="${CURSOR_AGENT_BIN:-}"
agent_model="${NOTION_MCP_HANDOFF_MODEL:-${NOTION_AGENT_MODEL:-composer-2.5}}"

while (($#)); do
  case "$1" in
    --ticket)
      shift
      ticket="${1:-}"
      ;;
    --workspace)
      shift
      workspace="${1:-}"
      ;;
    --output)
      shift
      output_rel="${1:-}"
      ;;
    --agent-bin)
      shift
      agent_bin="${1:-}"
      ;;
    --model)
      shift
      agent_model="${1:-}"
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -z "${ticket}" ]]; then
  echo "Missing required --ticket argument." >&2
  print_usage >&2
  exit 1
fi

if [[ ! -d "${workspace}" ]]; then
  echo "Workspace does not exist: ${workspace}" >&2
  exit 1
fi

if [[ -z "${agent_bin}" ]]; then
  if command -v cursor-agent >/dev/null 2>&1; then
    agent_bin="cursor-agent"
  elif [[ -x "${HOME}/.local/bin/cursor-agent" ]]; then
    agent_bin="${HOME}/.local/bin/cursor-agent"
  else
    echo "Could not find cursor-agent. Install it or pass --agent-bin /path/to/cursor-agent." >&2
    exit 1
  fi
fi

workspace_abs="$(cd "${workspace}" && pwd -P)"
if [[ "${output_rel}" = /* ]]; then
  output_file="${output_rel}"
else
  output_file="${workspace_abs}/${output_rel}"
fi

mkdir -p "$(dirname "${output_file}")"

prompt="$(cat <<EOF
Generate a delivery-ready engineering handoff markdown from this Notion ticket: ${ticket}

Requirements:
1) Use Notion MCP tools to retrieve full ticket details.
2) Include ticket content and relevant properties.
3) Include comments/discussions (open and resolved), newest context first.
4) Produce concise but complete instructions for implementation.
5) Write the final markdown to this exact file path:
${output_file}

Output structure:
- Title and metadata
- Problem statement
- Scope and non-scope
- Requirements and acceptance criteria
- Technical context
- Comment/discussion summary
- Implementation plan (ordered steps)
- Risks/unknowns and explicit questions
- Suggested reply text back to Notion after implementation

Do not ask follow-up questions. If some data is missing, explicitly list assumptions and proceed.
EOF
)"

echo "Generating handoff from ticket: ${ticket}"
echo "Workspace: ${workspace_abs}"
echo "Output: ${output_file}"

agent_args=(--workspace "${workspace_abs}")
if [[ -n "${agent_model}" && ! "${agent_model}" =~ ^(false|off|none|inherit|default|skip)$ ]]; then
  agent_args+=(--model "${agent_model}")
  echo "Model: ${agent_model}"
fi
agent_args+=("${prompt}")

"${agent_bin}" "${agent_args[@]}"

echo "Handoff generation request completed."
echo "Attach in chat with: @${output_rel}"
