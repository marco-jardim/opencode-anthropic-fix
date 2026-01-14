import { generatePKCE } from "@openauthjs/openauth/pkce";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// =============================================================================
// Tool Name Mapping: OpenCode (lowercase) → Claude Code (PascalCase)
// =============================================================================
const TOOL_NAME_MAP = {
  question: "AskUserQuestion",
  bash: "Bash",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  websearch: "WebSearch",
  skill: "Skill",
  googlesearch: "WebSearch",
  google_search: "WebSearch",
};

// Reverse mapping for response transformation
const REVERSE_TOOL_NAME_MAP = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([k, v]) => [v, k])
);

// =============================================================================
// Parameter Name Mapping: OpenCode (camelCase) → Claude Code (snake_case)
// =============================================================================
const PARAM_TO_CLAUDE = {
  read: { filePath: "file_path" },
  edit: {
    filePath: "file_path",
    oldString: "old_string",
    newString: "new_string",
    replaceAll: "replace_all",
  },
  write: { filePath: "file_path" },
  grep: { include: "glob" },
  question: { multiple: "multiSelect" },
  skill: { name: "skill" },
};

// Reverse parameter mapping for response transformation
const PARAM_TO_OPENCODE = {
  Read: { file_path: "filePath" },
  Edit: {
    file_path: "filePath",
    old_string: "oldString",
    new_string: "newString",
    replace_all: "replaceAll",
  },
  Write: { file_path: "filePath" },
  Grep: { glob: "include" },
  AskUserQuestion: { multiSelect: "multiple" },
  Skill: { skill: "name" },
};

// =============================================================================
// EXACT Claude Code Tool Definitions (extracted from real Claude Code request)
// Order: Task, TaskOutput, Bash, Glob, Grep, ExitPlanMode, Read, Edit, Write,
//        NotebookEdit, WebFetch, TodoWrite, WebSearch, KillShell, AskUserQuestion,
//        Skill, EnterPlanMode, LSP
// =============================================================================
const CLAUDE_CODE_TOOLS = [
  {
    "name": "Task",
    "description": "Launch a new agent to handle complex, multi-step tasks autonomously. \n\nThe Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.\n\nAvailable agent types and the tools they have access to:\n\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Glob tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- Other tasks that are not related to the agent descriptions above\n\n\nUsage notes:\n- Always include a short description (3-5 words) summarizing what the agent will do\n- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, the tool result will include an output_file path. To check on the agent's progress or retrieve its results, use the Read tool to read the output file, or use Bash with `tail` to see recent output. You can continue working while background agents run.\n- Agents can be resumed using the `resume` parameter by passing the agent ID from a previous invocation. When resumed, the agent continues with its full previous context preserved. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.\n- When the agent is done, it will return a single message back to you along with its agent ID. You can use this ID to resume the agent later if needed for follow-up work.\n- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.\n- Agents with \"access to current context\" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., \"investigate the error discussed above\") instead of repeating information. The agent will receive all prior messages and understand the context.\n- The agent's outputs should generally be trusted\n- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n- If the user specifies that they want you to run agents \"in parallel\", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.\n\nExample usage:\n\n<example_agent_descriptions>\n\"test-runner\": use this agent after you are done writing code to run tests\n\"greeting-responder\": use this agent when to respond to user greetings with a friendly joke\n</example_agent_description>\n\n<example>\nuser: \"Please write a function that checks if a number is prime\"\nassistant: Sure let me write a function that checks if a number is prime\nassistant: First let me use the Write tool to write a function that checks if a number is prime\nassistant: I'm going to use the Write tool to write the following code:\n<code>\nfunction isPrime(n) {\n  if (n <= 1) return false\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false\n  }\n  return true\n}\n</code>\n<commentary>\nSince a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests\n</commentary>\nassistant: Now let me use the test-runner agent to run the tests\nassistant: Uses the Task tool to launch the test-runner agent\n</example>\n\n<example>\nuser: \"Hello\"\n<commentary>\nSince the user is greeting, use the greeting-responder agent to respond with a friendly joke\n</commentary>\nassistant: \"I'm going to use the Task tool to launch the greeting-responder agent\"\n</example>\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "description": {
          "description": "A short (3-5 word) description of the task",
          "type": "string"
        },
        "prompt": {
          "description": "The task for the agent to perform",
          "type": "string"
        },
        "subagent_type": {
          "description": "The type of specialized agent to use for this task",
          "type": "string"
        },
        "model": {
          "description": "Optional model to use for this agent. If not specified, inherits from parent. Prefer haiku for quick, straightforward tasks to minimize cost and latency.",
          "type": "string",
          "enum": [
            "sonnet",
            "opus",
            "haiku"
          ]
        },
        "resume": {
          "description": "Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Set to true to run this agent in the background. The tool result will include an output_file path - use Read tool or Bash tail to check on output.",
          "type": "boolean"
        },
        "max_turns": {
          "description": "Maximum number of agentic turns (API round-trips) before stopping. Used internally for warmup.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "description",
        "prompt",
        "subagent_type"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "TaskOutput",
    "description": "- Retrieves output from a running or completed task (background shell, agent, or remote session)\n- Takes a task_id parameter identifying the task\n- Returns the task output along with status information\n- Use block=true (default) to wait for task completion\n- Use block=false for non-blocking check of current status\n- Task IDs can be found using the /tasks command\n- Works with all task types: background shells, async agents, and remote sessions",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "task_id": {
          "description": "The task ID to get output from",
          "type": "string"
        },
        "block": {
          "description": "Whether to wait for completion",
          "default": true,
          "type": "boolean"
        },
        "timeout": {
          "description": "Max wait time in ms",
          "default": 30000,
          "type": "number",
          "minimum": 0,
          "maximum": 600000
        }
      },
      "required": [
        "task_id",
        "block",
        "timeout"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Bash",
    "description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., cd \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - cd \"/Users/name/My Documents\" (correct)\n     - cd /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), add enough context to clarify what it does.\n  - If the output exceeds 30000 characters, output will be truncated before being returned to you.\n  \n  - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.\n  \n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two Bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.\n    <good-example>\n    pytest /foo/bar/tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Committing changes with git\n\nOnly create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them\n- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it\n- NEVER run force push to main/master, warn the user if they request it\n- Avoid git commit --amend. ONLY use --amend when ALL conditions are met:\n  (1) User explicitly requested amend, OR commit SUCCEEDED but pre-commit hook auto-modified files that need including\n  (2) HEAD commit was created by you in this conversation (verify: git log -1 --format='%an %ae')\n  (3) Commit has NOT been pushed to remote (verify: git status shows \"Your branch is ahead\")\n- CRITICAL: If commit FAILED or was REJECTED by hook, NEVER amend - fix the issue and create a NEW commit\n- CRITICAL: If you already pushed to remote, NEVER amend unless user explicitly requests it (requires force push)\n- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel, each using the Bash tool:\n  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.\n  - Run a git diff command to see both staged and unstaged changes that will be committed.\n  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:\n  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.).\n  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files\n  - Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n  - Ensure it accurately reflects the changes and their purpose\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands:\n   - Add relevant untracked files to the staging area.\n   - Create the commit with a message ending with:\n   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>\n   - Run git status after the commit completes to verify success.\n   Note: git status depends on the commit completing, so run it sequentially after the commit.\n4. If the commit fails due to pre-commit hook, fix the issue and create a NEW commit (see amend rules above)\n\nImportant notes:\n- NEVER run additional commands to read or explore code, besides git bash commands\n- NEVER use the TodoWrite or Task tools\n- DO NOT push to the remote repository unless the user explicitly asks you to do so\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:\n<example>\ngit commit -m \"$(cat <<'EOF'\n   Commit message here.\n\n   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>\n   EOF\n   )\"\n</example>\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files (never use -uall flag)\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch)\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request summary\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\n\n## Test plan\n[Bulleted markdown checklist of TODOs for testing the pull request...]\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nEOF\n)\"\n</example>\n\nImportant:\n- DO NOT use the TodoWrite or Task tools\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "command": {
          "description": "The command to execute",
          "type": "string"
        },
        "timeout": {
          "description": "Optional timeout in milliseconds (max 600000)",
          "type": "number"
        },
        "description": {
          "description": "Clear, concise description of what this command does in active voice. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → \"List files in current directory\"\n- git status → \"Show working tree status\"\n- npm install → \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name \"*.tmp\" -exec rm {} \\; → \"Find and delete all .tmp files recursively\"\n- git reset --hard origin/main → \"Discard all local changes and match remote main\"\n- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
          "type": "string"
        },
        "run_in_background": {
          "description": "Set to true to run this command in the background. Use TaskOutput to read the output later.",
          "type": "boolean"
        },
        "dangerouslyDisableSandbox": {
          "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
          "type": "boolean"
        },
        "_simulatedSedEdit": {
          "description": "Internal: pre-computed sed edit result from preview",
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string"
            },
            "newContent": {
              "type": "string"
            }
          },
          "required": [
            "filePath",
            "newContent"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "command"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Glob",
    "description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "description": "The glob pattern to match files against",
          "type": "string"
        },
        "path": {
          "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
          "type": "string"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Grep",
    "description": "A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\")\n  - Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\")\n  - Output modes: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts\n  - Use Task tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "description": "The regular expression pattern to search for in file contents",
          "type": "string"
        },
        "path": {
          "description": "File or directory to search in (rg PATH). Defaults to current working directory.",
          "type": "string"
        },
        "glob": {
          "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob",
          "type": "string"
        },
        "output_mode": {
          "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\".",
          "type": "string",
          "enum": [
            "content",
            "files_with_matches",
            "count"
          ]
        },
        "-B": {
          "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-A": {
          "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-C": {
          "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-n": {
          "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true.",
          "type": "boolean"
        },
        "-i": {
          "description": "Case insensitive search (rg -i)",
          "type": "boolean"
        },
        "type": {
          "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
          "type": "string"
        },
        "head_limit": {
          "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 0 (unlimited).",
          "type": "number"
        },
        "offset": {
          "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0.",
          "type": "number"
        },
        "multiline": {
          "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
          "type": "boolean"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "ExitPlanMode",
    "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\n\n## How This Tool Works\n- You should have already written your plan to the plan file specified in the plan mode system message\n- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote\n- This tool simply signals that you're done planning and ready for the user to review and approve\n- The user will see the contents of your plan file when they review it\n\n## Requesting Permissions (allowedPrompts)\nWhen calling this tool, you can request prompt-based permissions for bash commands your plan will need. These are semantic descriptions of actions, not literal commands.\n\n**How to use:**\n```json\n{\n  \"allowedPrompts\": [\n    { \"tool\": \"Bash\", \"prompt\": \"run tests\" },\n    { \"tool\": \"Bash\", \"prompt\": \"install dependencies\" },\n    { \"tool\": \"Bash\", \"prompt\": \"build the project\" }\n  ]\n}\n```\n\n**Guidelines for prompts:**\n- Use semantic descriptions that capture the action's purpose, not specific commands\n- \"run tests\" matches: npm test, pytest, go test, bun test, etc.\n- \"install dependencies\" matches: npm install, pip install, cargo build, etc.\n- \"build the project\" matches: npm run build, make, cargo build, etc.\n- Keep descriptions concise but descriptive\n- Only request permissions you actually need for the plan\n- Scope permissions narrowly, like a security-conscious human would:\n  - **Never combine multiple actions into one permission** - split them into separate, specific permissions (e.g. \"list pods in namespace X\", \"view logs in namespace X\")\n  - Prefer \"run read-only database queries\" over \"run database queries\"\n  - Prefer \"run tests in the project\" over \"run code\"\n  - Add constraints like \"read-only\", \"local\", \"non-destructive\" whenever possible. If you only need read-only access, you must only request read-only access.\n  - Prefer not to request overly broad permissions that would grant dangerous access, especially any access to production data or to make irrecoverable changes\n  - When interacting with cloud environments, add constraints like \"in the foobar project\", \"in the baz namespace\", \"in the foo DB table\"\n  - Never request broad tool access like \"run k8s commands\" - always scope to specific actions and namespaces, ideally with constraints such as read-only\n\n**Benefits:**\n- Commands matching approved prompts won't require additional permission prompts\n- The user sees the requested permissions when approving the plan\n- Permissions are session-scoped and cleared when the session ends\n\n## When to Use This Tool\nIMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.\n\n## Before Using This Tool\nEnsure your plan is complete and unambiguous:\n- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)\n- Once your plan is finalized, use THIS tool to request approval\n\n**Important:** Do NOT use AskUserQuestion to ask \"Is this plan okay?\" or \"Should I proceed?\" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.\n\n## Examples\n\n1. Initial task: \"Search for and understand the implementation of vim mode in the codebase\" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.\n2. Initial task: \"Help me implement yank mode for vim\" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.\n3. Initial task: \"Add a new feature to handle user authentication\" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "allowedPrompts": {
          "description": "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "tool": {
                "description": "The tool this prompt applies to",
                "type": "string",
                "enum": [
                  "Bash"
                ]
              },
              "prompt": {
                "description": "Semantic description of the action, e.g. \"run tests\", \"install dependencies\"",
                "type": "string"
              }
            },
            "required": [
              "tool",
              "prompt"
            ],
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": {}
    }
  },
  {
    "name": "Read",
    "description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The file_path parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Any lines longer than 2000 characters will be truncated\n- Results are returned using cat -n format, with line numbers starting at 1\n- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.\n- This tool can read PDF files (.pdf). PDFs are processed page by page, extracting both text and visual content for analysis.\n- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.\n- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.\n- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.\n- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to read",
          "type": "string"
        },
        "offset": {
          "description": "The line number to start reading from. Only provide if the file is too large to read at once",
          "type": "number"
        },
        "limit": {
          "description": "The number of lines to read. Only provide if the file is too large to read at once.",
          "type": "number"
        }
      },
      "required": [
        "file_path"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Edit",
    "description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`. \n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to modify",
          "type": "string"
        },
        "old_string": {
          "description": "The text to replace",
          "type": "string"
        },
        "new_string": {
          "description": "The text to replace it with (must be different from old_string)",
          "type": "string"
        },
        "replace_all": {
          "description": "Replace all occurences of old_string (default false)",
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "file_path",
        "old_string",
        "new_string"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Write",
    "description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to write (must be absolute, not relative)",
          "type": "string"
        },
        "content": {
          "description": "The content to write to the file",
          "type": "string"
        }
      },
      "required": [
        "file_path",
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "NotebookEdit",
    "description": "Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "notebook_path": {
          "description": "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)",
          "type": "string"
        },
        "cell_id": {
          "description": "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.",
          "type": "string"
        },
        "new_source": {
          "description": "The new source for the cell",
          "type": "string"
        },
        "cell_type": {
          "description": "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.",
          "type": "string",
          "enum": [
            "code",
            "markdown"
          ]
        },
        "edit_mode": {
          "description": "The type of edit to make (replace, insert, delete). Defaults to replace.",
          "type": "string",
          "enum": [
            "replace",
            "insert",
            "delete"
          ]
        }
      },
      "required": [
        "notebook_path",
        "new_source"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "WebFetch",
    "description": "\n- Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Processes the content with the prompt using a small, fast model\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL\n  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "url": {
          "description": "The URL to fetch content from",
          "type": "string",
          "format": "uri"
        },
        "prompt": {
          "description": "The prompt to run on the fetched content",
          "type": "string"
        }
      },
      "required": [
        "url",
        "prompt"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "TodoWrite",
    "description": "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos\n6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time\n7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Examples of When to Use the Todo List\n\n<example>\nUser: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!\nAssistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.\n*Creates todo list with the following items:*\n1. Creating dark mode toggle component in Settings page\n2. Adding dark mode state management (context/store)\n3. Implementing CSS-in-JS styles for dark theme\n4. Updating existing components to support theme switching\n5. Running tests and build process, addressing any failures or errors that occur\n*Begins working on the first task*\n\n<reasoning>\nThe assistant used the todo list because:\n1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes\n2. The user explicitly requested tests and build be run afterward\n3. The assistant inferred that tests and build need to pass by adding \"Ensure tests and build succeed\" as the final task\n</reasoning>\n</example>\n\n<example>\nUser: Help me rename the function getCwd to getCurrentWorkingDirectory across my project\nAssistant: Let me first search through your codebase to find all occurrences of 'getCwd'.\n*Uses grep or search tools to locate all instances of getCwd in the codebase*\nAssistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.\n*Creates todo list with specific items for each file that needs updating*\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant searched to understand the scope of the task\n2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps\n3. The todo list helps ensure every instance is tracked and updated systematically\n4. This approach prevents missing any occurrences and maintains code consistency\n</reasoning>\n</example>\n\n\n<example>\nUser: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.\nAssistant: I'll help implement these features. First, let's add all the features to the todo list.\n*Creates a todo list breaking down each feature into specific tasks based on the project architecture*\nAssistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.\n\n<reasoning>\nThe assistant used the todo list because:\n1. The user provided multiple complex features to implement in a comma separated list\n2. The todo list helps organize these large features into manageable tasks\n3. This approach allows for tracking progress across the entire implementation\n</reasoning>\n</example>\n\n<example>\nUser: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>\nAssistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.\n*Reviews component structure, render patterns, state management, and data fetching*\nAssistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.\n*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*\nLet's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant examined the codebase to identify specific performance issues\n2. Based on this analysis, it identified multiple optimization opportunities\n3. Performance optimization is a non-trivial task requiring multiple steps\n4. The todo list helps methodically track improvements across different components\n5. This systematic approach ensures all performance bottlenecks are addressed\n</reasoning>\n</example>\n\n## Examples of When NOT to Use the Todo List\n\n<example>\nUser: How do I print 'Hello World' in Python?\nAssistant: In Python, you can print \"Hello World\" with this simple code:\n\npython\nprint(\"Hello World\")\n\nThis will output the text \"Hello World\" to the console when executed.</assistant>\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.\n</reasoning>\n</example>\n\n<example>\nUser: What does the git status command do?\nAssistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.\n\n<reasoning>\nThe assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.\n</reasoning>\n</example>\n\n<example>\nUser: Can you add a comment to the calculateTotal function to explain what it does?\nAssistant: Sure, let me add a comment to the calculateTotal function to explain what it does.\n* Uses the Edit tool to add a comment to the calculateTotal function *\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.\n</reasoning>\n</example>\n\n<example>\nUser: Run npm install for me and tell me what happens.\nAssistant: I'll run the npm install command for you.\n\n*Executes: npm install*\n\nThe command completed successfully. Here's the output:\n[Output of npm install command]\n\nAll dependencies have been installed according to your package.json file.\n\n<reasoning>\nThe assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.\n</reasoning>\n</example>\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n\n   **IMPORTANT**: Task descriptions must have two forms:\n   - content: The imperative form describing what needs to be done (e.g., \"Run tests\", \"Build the project\")\n   - activeForm: The present continuous form shown during execution (e.g., \"Running tests\", \"Building the project\")\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Exactly ONE task must be in_progress at any time (not less, not more)\n   - Complete current tasks before starting new ones\n   - Remove tasks that are no longer relevant from the list entirely\n\n3. **Task Completion Requirements**:\n   - ONLY mark a task as completed when you have FULLY accomplished it\n   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress\n   - When blocked, create a new task describing what needs to be resolved\n   - Never mark a task as completed if:\n     - Tests are failing\n     - Implementation is partial\n     - You encountered unresolved errors\n     - You couldn't find necessary files or dependencies\n\n4. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n   - Always provide both forms:\n     - content: \"Fix authentication bug\"\n     - activeForm: \"Fixing authentication bug\"\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "todos": {
          "description": "The updated todo list",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "in_progress",
                  "completed"
                ]
              },
              "activeForm": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "content",
              "status",
              "activeForm"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "todos"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "WebSearch",
    "description": "\n- Allows Claude to search the web and use the results to inform responses\n- Provides up-to-date information for current events and recent data\n- Returns search result information formatted as search result blocks, including links as markdown hyperlinks\n- Use this tool for accessing information beyond Claude's knowledge cutoff\n- Searches are performed automatically within a single API call\n\nCRITICAL REQUIREMENT - You MUST follow this:\n  - After answering the user's question, you MUST include a \"Sources:\" section at the end of your response\n  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)\n  - This is MANDATORY - never skip including sources in your response\n  - Example format:\n\n    [Your answer here]\n\n    Sources:\n    - [Source Title 1](https://example.com/1)\n    - [Source Title 2](https://example.com/2)\n\nUsage notes:\n  - Domain filtering is supported to include or block specific websites\n  - Web search is only available in the US\n\nIMPORTANT - Use the correct year in search queries:\n  - Today's date is 2026-01-14. You MUST use this year when searching for recent information, documentation, or current events.\n  - Example: If today is 2025-07-15 and the user asks for \"latest React docs\", search for \"React documentation 2025\", NOT \"React documentation 2024\"\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "query": {
          "description": "The search query to use",
          "type": "string",
          "minLength": 2
        },
        "allowed_domains": {
          "description": "Only include search results from these domains",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blocked_domains": {
          "description": "Never include search results from these domains",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "KillShell",
    "description": "\n- Kills a running background bash shell by its ID\n- Takes a shell_id parameter identifying the shell to kill\n- Returns a success or failure status \n- Use this tool when you need to terminate a long-running shell\n- Shell IDs can be found using the /tasks command\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "shell_id": {
          "description": "The ID of the background shell to kill",
          "type": "string"
        }
      },
      "required": [
        "shell_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "AskUserQuestion",
    "description": "Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- Users will always be able to select \"Other\" to provide custom text input\n- Use multiSelect: true to allow multiple answers to be selected for a question\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label\n\nPlan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask \"Is my plan ready?\" or \"Should I proceed?\" - use ExitPlanMode for plan approval.\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "questions": {
          "description": "Questions to ask the user (1-4 questions)",
          "minItems": 1,
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "question": {
                "description": "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\"",
                "type": "string"
              },
              "header": {
                "description": "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\".",
                "type": "string"
              },
              "options": {
                "description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
                "minItems": 2,
                "maxItems": 4,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "label": {
                      "description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
                      "type": "string"
                    },
                    "description": {
                      "description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
                      "type": "string"
                    }
                  },
                  "required": [
                    "label",
                    "description"
                  ],
                  "additionalProperties": false
                }
              },
              "multiSelect": {
                "description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "question",
              "header",
              "options",
              "multiSelect"
            ],
            "additionalProperties": false
          }
        },
        "answers": {
          "description": "User answers collected by the permission component",
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "metadata": {
          "description": "Optional metadata for tracking and analytics purposes. Not displayed to user.",
          "type": "object",
          "properties": {
            "source": {
              "description": "Optional identifier for the source of this question (e.g., \"remember\" for /remember command). Used for analytics tracking.",
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "questions"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Skill",
    "description": "Execute a skill within the main conversation\n\nWhen users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.\n\nWhen users ask you to run a \"slash command\" or reference \"/<something>\" (e.g., \"/commit\", \"/review-pr\"), they are referring to a skill. Use this tool to invoke the corresponding skill.\n\nExample:\n  User: \"run /commit\"\n  Assistant: [Calls Skill tool with skill: \"commit\"]\n\nHow to invoke:\n- Use this tool with the skill name and optional arguments\n- Examples:\n  - `skill: \"pdf\"` - invoke the pdf skill\n  - `skill: \"commit\", args: \"-m 'Fix bug'\"` - invoke with arguments\n  - `skill: \"review-pr\", args: \"123\"` - invoke with arguments\n  - `skill: \"ms-office-suite:pdf\"` - invoke using fully qualified name\n\nImportant:\n- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action\n- NEVER just announce or mention a skill in your text response without actually calling this tool\n- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- Only use skills listed in \"Available skills\" below\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n- If you see a <command-name> tag in the current conversation turn (e.g., <command-name>/commit</command-name>), the skill has ALREADY been loaded and its instructions follow in the next message. Do NOT call this tool - just follow the skill instructions directly.\n\nAvailable skills:\n\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "skill": {
          "description": "The skill name. E.g., \"commit\", \"review-pr\", or \"pdf\"",
          "type": "string"
        },
        "args": {
          "description": "Optional arguments for the skill",
          "type": "string"
        }
      },
      "required": [
        "skill"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "EnterPlanMode",
    "description": "Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n## When to Use This Tool\n\n**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:\n\n1. **New Feature Implementation**: Adding meaningful new functionality\n   - Example: \"Add a logout button\" - where should it go? What should happen on click?\n   - Example: \"Add form validation\" - what rules? What error messages?\n\n2. **Multiple Valid Approaches**: The task can be solved in several different ways\n   - Example: \"Add caching to the API\" - could use Redis, in-memory, file-based, etc.\n   - Example: \"Improve performance\" - many optimization strategies possible\n\n3. **Code Modifications**: Changes that affect existing behavior or structure\n   - Example: \"Update the login flow\" - what exactly should change?\n   - Example: \"Refactor this component\" - what's the target architecture?\n\n4. **Architectural Decisions**: The task requires choosing between patterns or technologies\n   - Example: \"Add real-time updates\" - WebSockets vs SSE vs polling\n   - Example: \"Implement state management\" - Redux vs Context vs custom solution\n\n5. **Multi-File Changes**: The task will likely touch more than 2-3 files\n   - Example: \"Refactor the authentication system\"\n   - Example: \"Add a new API endpoint with tests\"\n\n6. **Unclear Requirements**: You need to explore before understanding the full scope\n   - Example: \"Make the app faster\" - need to profile and identify bottlenecks\n   - Example: \"Fix the bug in checkout\" - need to investigate root cause\n\n7. **User Preferences Matter**: The implementation could reasonably go multiple ways\n   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead\n   - Plan mode lets you explore first, then present options with context\n\n## When NOT to Use This Tool\n\nOnly skip EnterPlanMode for simple tasks:\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\n- Adding a single function with clear requirements\n- Tasks where the user has given very specific, detailed instructions\n- Pure research/exploration tasks (use the Task tool with explore agent instead)\n\n## What Happens in Plan Mode\n\nIn plan mode, you'll:\n1. Thoroughly explore the codebase using Glob, Grep, and Read tools\n2. Understand existing patterns and architecture\n3. Design an implementation approach\n4. Present your plan to the user for approval\n5. Use AskUserQuestion if you need to clarify approaches\n6. Exit plan mode with ExitPlanMode when ready to implement\n\n## Examples\n\n### GOOD - Use EnterPlanMode:\nUser: \"Add user authentication to the app\"\n- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)\n\nUser: \"Optimize the database queries\"\n- Multiple approaches possible, need to profile first, significant impact\n\nUser: \"Implement dark mode\"\n- Architectural decision on theme system, affects many components\n\nUser: \"Add a delete button to the user profile\"\n- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates\n\nUser: \"Update the error handling in the API\"\n- Affects multiple files, user should approve the approach\n\n### BAD - Don't use EnterPlanMode:\nUser: \"Fix the typo in the README\"\n- Straightforward, no planning needed\n\nUser: \"Add a console.log to debug this function\"\n- Simple, obvious implementation\n\nUser: \"What files handle routing?\"\n- Research task, not implementation planning\n\n## Important Notes\n\n- This tool REQUIRES user approval - they must consent to entering plan mode\n- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work\n- Users appreciate being consulted before significant changes are made to their codebase\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "LSP",
    "description": "Interact with Language Server Protocol (LSP) servers to get code intelligence features.\n\nSupported operations:\n- goToDefinition: Find where a symbol is defined\n- findReferences: Find all references to a symbol\n- hover: Get hover information (documentation, type info) for a symbol\n- documentSymbol: Get all symbols (functions, classes, variables) in a document\n- workspaceSymbol: Search for symbols across the entire workspace\n- goToImplementation: Find implementations of an interface or abstract method\n- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)\n- incomingCalls: Find all functions/methods that call the function at a position\n- outgoingCalls: Find all functions/methods called by the function at a position\n\nAll operations require:\n- filePath: The file to operate on\n- line: The line number (1-based, as shown in editors)\n- character: The character offset (1-based, as shown in editors)\n\nNote: LSP servers must be configured for the file type. If no server is available, an error will be returned.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "operation": {
          "description": "The LSP operation to perform",
          "type": "string",
          "enum": [
            "goToDefinition",
            "findReferences",
            "hover",
            "documentSymbol",
            "workspaceSymbol",
            "goToImplementation",
            "prepareCallHierarchy",
            "incomingCalls",
            "outgoingCalls"
          ]
        },
        "filePath": {
          "description": "The absolute or relative path to the file",
          "type": "string"
        },
        "line": {
          "description": "The line number (1-based, as shown in editors)",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "character": {
          "description": "The character offset (1-based, as shown in editors)",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "operation",
        "filePath",
        "line",
        "character"
      ],
      "additionalProperties": false
    }
  }
];

// =============================================================================
// Transform tool name: OpenCode/mcp_prefixed → Claude Code
// =============================================================================
function transformToolName(name) {
  // Handle already mcp_ prefixed names (from earlier plugin)
  let baseName = name;
  if (name.startsWith("mcp_")) {
    baseName = name.slice(4); // Remove mcp_ prefix
  }

  // Check if it's a known tool
  if (TOOL_NAME_MAP[baseName]) {
    return TOOL_NAME_MAP[baseName];
  }

  // Unknown tool - keep/add mcp_ prefix
  return name.startsWith("mcp_") ? name : `mcp_${name}`;
}

// =============================================================================
// Transform tool name back: Claude Code → OpenCode
// =============================================================================
function reverseTransformToolName(name) {
  // Strip mcp_ prefix first
  if (name.startsWith("mcp_")) {
    return name.slice(4);
  }
  // Check reverse mapping
  if (REVERSE_TOOL_NAME_MAP[name]) {
    return REVERSE_TOOL_NAME_MAP[name];
  }
  // Return lowercase version as fallback
  return name.toLowerCase();
}

// =============================================================================
// Transform parameters: OpenCode → Claude Code
// =============================================================================
function transformParams(toolName, params) {
  if (!params || typeof params !== "object") return params;

  // Get base name (without mcp_ prefix)
  let baseName = toolName;
  if (toolName && toolName.startsWith("mcp_")) {
    baseName = toolName.slice(4);
  }

  const mapping = PARAM_TO_CLAUDE[baseName];
  if (!mapping) return params;

  const transformed = {};
  for (const [key, value] of Object.entries(params)) {
    const newKey = mapping[key] || key;
    transformed[newKey] = value;
  }

  // Special handling for webfetch - add required prompt if missing
  if (baseName === "webfetch" && !transformed.prompt) {
    transformed.prompt = "Extract and summarize the content from this page.";
  }

  // Special handling for todowrite - add activeForm if missing
  if (baseName === "todowrite" && transformed.todos) {
    transformed.todos = transformed.todos.map((todo) => {
      if (!todo.activeForm && todo.content) {
        // Generate activeForm from content (convert imperative to present continuous)
        todo.activeForm = todo.content.replace(/^(\w+)/, (match) => {
          if (match.endsWith("e")) return match.slice(0, -1) + "ing";
          return match + "ing";
        });
      }
      // Remove unsupported fields
      delete todo.priority;
      delete todo.id;
      return todo;
    });
  }

  // Remove unsupported fields
  if (baseName === "bash") {
    delete transformed.workdir;
  }
  if (baseName === "webfetch") {
    delete transformed.format;
  }
  if (baseName === "websearch" || baseName === "googlesearch" || baseName === "google_search") {
    delete transformed.numResults;
    delete transformed.livecrawl;
    delete transformed.type;
    delete transformed.contextMaxCharacters;
    delete transformed.urls;
    delete transformed.thinking;
  }

  return transformed;
}

// =============================================================================
// Transform parameters back: Claude Code → OpenCode
// =============================================================================
function reverseTransformParams(claudeName, params) {
  if (!params || typeof params !== "object") return params;

  const mapping = PARAM_TO_OPENCODE[claudeName];
  if (!mapping) return params;

  const transformed = {};
  for (const [key, value] of Object.entries(params)) {
    const newKey = mapping[key] || key;
    transformed[newKey] = value;
  }
  return transformed;
}

// =============================================================================
// Transform tool definition: OpenCode/mcp_prefixed format → Claude Code format
// =============================================================================
function transformToolDefinition(tool) {
  // Handle OpenCode format: { type: "function", function: { name, parameters } }
  const isOpenCodeFormat = tool.type === "function" && tool.function;
  const toolName = isOpenCodeFormat ? tool.function.name : tool.name;
  const toolParams = isOpenCodeFormat ? tool.function.parameters : tool.input_schema;

  // Get base name (without mcp_ prefix) for mapping lookups
  let baseName = toolName;
  if (toolName && toolName.startsWith("mcp_")) {
    baseName = toolName.slice(4);
  }

  const claudeName = transformToolName(toolName);
  const description = tool.function?.description || tool.description || "";

  // Transform parameter schema property names
  let inputSchema = toolParams ? { ...toolParams } : { type: "object", properties: {}, additionalProperties: false };

  // Add $schema if not present
  if (!inputSchema.$schema) {
    inputSchema.$schema = "https://json-schema.org/draft/2020-12/schema";
  }

  // Transform property names in schema using base name for lookup
  const paramMapping = PARAM_TO_CLAUDE[baseName];
  if (paramMapping && inputSchema.properties) {
    const newProperties = {};
    for (const [key, value] of Object.entries(inputSchema.properties)) {
      const newKey = paramMapping[key] || key;
      newProperties[newKey] = value;
    }
    inputSchema.properties = newProperties;

    // Transform required array
    if (inputSchema.required) {
      inputSchema.required = inputSchema.required.map((r) => paramMapping[r] || r);
    }
  }

  return {
    name: claudeName,
    description,
    input_schema: inputSchema,
  };
}

// =============================================================================
// Transform request body: OpenCode → Claude Code
// =============================================================================
function transformRequestBody(parsed) {
  // COMPLETELY REPLACE tools with exact Claude Code definitions
  if (parsed.tools && Array.isArray(parsed.tools)) {
    console.error(`[AUTH PLUGIN] Replacing ${parsed.tools.length} OpenCode tools with ${CLAUDE_CODE_TOOLS.length} Claude Code tools`);
    parsed.tools = CLAUDE_CODE_TOOLS;
  }

  // Keep metadata but ensure user_id exists (Claude Code requires this)
  if (!parsed.metadata) {
    parsed.metadata = {};
  }
  if (!parsed.metadata.user_id) {
    // Generate a user_id in Claude Code format
    const randomHex = () => Math.random().toString(16).substring(2);
    parsed.metadata.user_id = `user_${randomHex()}${randomHex()}_account_${randomHex()}-${randomHex().substring(0,4)}-${randomHex().substring(0,4)}-${randomHex().substring(0,4)}-${randomHex()}${randomHex().substring(0,4)}_session_${randomHex()}-${randomHex().substring(0,4)}-${randomHex().substring(0,4)}-${randomHex().substring(0,4)}-${randomHex()}${randomHex().substring(0,4)}`;
    console.error("[AUTH PLUGIN] Generated user_id for metadata");
  }

  // Remove thinking/tool_choice not used by Claude Code
  delete parsed.thinking;
  delete parsed.tool_choice;

  // Keep stream, max_tokens, system as arrays - Claude Code uses these
  // DO NOT convert system to string - Claude Code sends it as array

  // Sanitize system prompt array - remove OpenCode references
  if (parsed.system && Array.isArray(parsed.system)) {
    parsed.system = parsed.system.map(item => {
      if (item.type === 'text' && item.text) {
        return {
          ...item,
          text: item.text
            .replace(/You are OpenCode[^.]*\./g, '')
            .replace(/OpenCode/g, 'Claude Code')
            .replace(/opencode/gi, 'claude')
        };
      }
      return item;
    });
    console.error("[AUTH PLUGIN] Sanitized system array, items:", parsed.system.length);
  }

  // Fix model name to include date suffix (Agent SDK format)
  if (parsed.model) {
    const modelMap = {
      "claude-opus-4-5": "claude-opus-4-5-20251101",
      "claude-sonnet-4-5": "claude-sonnet-4-5-20251022",
      "claude-haiku-4-5": "claude-haiku-4-5-20251001",
      "claude-sonnet-4": "claude-sonnet-4-20250514",
    };
    if (modelMap[parsed.model]) {
      parsed.model = modelMap[parsed.model];
    }
  }

  // Transform tool_use blocks in messages (keep cache_control, keep array format)
  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((msg) => {
      if (msg.content && Array.isArray(msg.content)) {
        msg.content = msg.content.map((block) => {
          if (block.type === "tool_use" && block.name) {
            const opencodeName = block.name;
            const claudeName = transformToolName(opencodeName);
            return {
              ...block,
              name: claudeName,
              input: transformParams(opencodeName, block.input),
            };
          }
          return block;
        });
      }
      return msg;
    });
  }

  return parsed;
}

// =============================================================================
// Transform response text (streaming): Claude Code → OpenCode
// =============================================================================
function transformResponseText(text) {
  // Transform tool names in response
  // Match "name": "ToolName" patterns
  return text.replace(/"name"\s*:\s*"([^"]+)"/g, (_, name) => {
    const opencodeToolName = reverseTransformToolName(name);
    return `"name": "${opencodeToolName}"`;
  });
}

// =============================================================================
// Transform response parameters (streaming): Claude Code → OpenCode
// =============================================================================
function transformResponseParams(text) {
  // Transform snake_case parameter names to camelCase in input objects
  // This handles the streaming response where we see "input": {"file_path": "..."}
  const paramReplacements = {
    '"file_path"': '"filePath"',
    '"old_string"': '"oldString"',
    '"new_string"': '"newString"',
    '"replace_all"': '"replaceAll"',
    '"multiSelect"': '"multiple"',
  };

  for (const [from, to] of Object.entries(paramReplacements)) {
    text = text.split(from).join(to);
  }

  return text;
}

/**
 * @param {"max" | "console"} mode
 */
async function authorize(mode) {
  const pkce = await generatePKCE();

  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
    import.meta.url,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

/**
 * @param {string} code
 * @param {string} verifier
 */
async function exchange(code, verifier) {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok)
    return {
      type: "failed",
    };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }
          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              const auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);
              if (!auth.access || auth.expires < Date.now()) {
                const response = await fetch(
                  "https://console.anthropic.com/v1/oauth/token",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      grant_type: "refresh_token",
                      refresh_token: auth.refresh,
                      client_id: CLIENT_ID,
                    }),
                  },
                );
                if (!response.ok) {
                  throw new Error(`Token refresh failed: ${response.status}`);
                }
                const json = await response.json();
                await client.auth.set({
                  path: {
                    id: "anthropic",
                  },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                  },
                });
                auth.access = json.access_token;
              }
              const requestInit = init ?? {};

              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(requestInit.headers)) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const includeClaudeCode = incomingBetasList.includes(
                "claude-code-20250219",
              );

              // Agent SDK beta flags (with claude-code-20250219)
              const mergedBetas = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14";

              // Set OAuth authorization
              requestHeaders.set("authorization", `Bearer ${auth.access}`);
              requestHeaders.set("anthropic-beta", mergedBetas);
              console.error("[AUTH PLUGIN] Setting anthropic-beta to:", mergedBetas);
              console.error("[AUTH PLUGIN] After set, anthropic-beta is:", requestHeaders.get("anthropic-beta"));

              // Claude Code identification headers (from real Claude Code request)
              requestHeaders.set("Accept", "application/json");
              requestHeaders.set("x-app", "cli");
              requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
              requestHeaders.set("anthropic-version", "2023-06-01");
              requestHeaders.set("accept-language", "*");
              requestHeaders.set("sec-fetch-mode", "cors");
              requestHeaders.set("User-Agent", "claude-cli/2.1.3 (external, cli)");

              // X-Stainless headers (from real Claude Code request)
              requestHeaders.set("X-Stainless-Retry-Count", "0");
              requestHeaders.set("X-Stainless-Lang", "js");
              requestHeaders.set("X-Stainless-Package-Version", "0.70.0");
              requestHeaders.set("X-Stainless-OS", "MacOS");
              requestHeaders.set("X-Stainless-Arch", "arm64");
              requestHeaders.set("X-Stainless-Runtime", "node");
              requestHeaders.set("X-Stainless-Runtime-Version", "v22.21.1");
              requestHeaders.set("X-Stainless-Timeout", "600");
              requestHeaders.set("x-stainless-helper-method", "stream");

              requestHeaders.delete("x-api-key");

              // Transform request body: OpenCode format → Claude Code format
              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);
                  // DEBUG: Log before transformation
                  console.error("[AUTH PLUGIN] Transforming request, tools count:", parsed.tools?.length);
                  // Transform tools and messages using the transformation functions
                  transformRequestBody(parsed);
                  // DEBUG: Log after transformation
                  if (parsed.tools) {
                    console.error("[AUTH PLUGIN] Tools after transform:", parsed.tools.length, parsed.tools.map(t => t.name));
                  }
                  body = JSON.stringify(parsed);
                  console.error("[AUTH PLUGIN] Final body length:", body.length);
                } catch (e) {
                  console.error("[AUTH PLUGIN] Parse error:", e.message);
                }
              }

              let requestInput = input;
              let requestUrl = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Transform streaming response: Claude Code format → OpenCode format
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    // Transform tool names and parameters back to OpenCode format
                    text = transformResponseText(text);
                    // Also transform parameter names in input objects
                    text = transformResponseParams(text);
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        return {};
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                return credentials;
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json());
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}
