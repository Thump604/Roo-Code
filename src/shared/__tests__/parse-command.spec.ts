import { parseCommand } from "../parse-command"

// =============================================================================
// Basic cases (already working — regression coverage)
// =============================================================================

describe("parseCommand — basic cases", () => {
	it("returns empty array for empty input", () => {
		expect(parseCommand("")).toEqual([])
		expect(parseCommand("   ")).toEqual([])
	})

	it("parses a simple command", () => {
		expect(parseCommand("echo hello")).toEqual(["echo hello"])
	})

	it("splits on && operator", () => {
		const result = parseCommand("echo a && echo b")
		expect(result).toContain("echo a")
		expect(result).toContain("echo b")
	})

	it("splits on || operator", () => {
		const result = parseCommand("echo a || echo b")
		expect(result).toContain("echo a")
		expect(result).toContain("echo b")
	})

	it("splits on ; operator", () => {
		const result = parseCommand("echo a ; echo b")
		expect(result).toContain("echo a")
		expect(result).toContain("echo b")
	})

	it("splits on pipe operator", () => {
		const result = parseCommand("cat file.txt | grep hello")
		expect(result.length).toBeGreaterThanOrEqual(2)
	})
})

// =============================================================================
// Multiline quoted git commit messages
// =============================================================================

describe("parseCommand — multiline quoted strings", () => {
	it("preserves multiline double-quoted git commit messages", () => {
		const cmd = 'git commit -m "first line\nsecond line\nthird line"'
		const result = parseCommand(cmd)
		// Should be a single command, not split on newlines inside quotes
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("git commit")
		expect(result[0]).toContain("first line")
		expect(result[0]).toContain("third line")
	})

	it("preserves multiline single-quoted strings", () => {
		const cmd = "echo 'line one\nline two'"
		const result = parseCommand(cmd)
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("line one")
		expect(result[0]).toContain("line two")
	})

	it("splits correctly when multiline quotes are followed by &&", () => {
		const cmd = 'git commit -m "line one\nline two" && git push'
		const result = parseCommand(cmd)
		// Should produce two commands: git commit and git push
		expect(result.length).toBe(2)
		expect(result[0]).toContain("git commit")
		expect(result[1]).toContain("git push")
	})

	it("handles newlines inside heredoc-style quoted strings", () => {
		const cmd = "cat <<EOF\nhello world\nEOF"
		const result = parseCommand(cmd)
		// Heredoc is complex — at minimum should not crash
		expect(result.length).toBeGreaterThanOrEqual(1)
	})
})

// =============================================================================
// Command chains with &&, ||, ;, and pipes
// =============================================================================

describe("parseCommand — command chains", () => {
	it("does not split && inside double quotes", () => {
		const result = parseCommand('echo "a && b"')
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("a && b")
	})

	it("does not split || inside double quotes", () => {
		const result = parseCommand('echo "a || b"')
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("a || b")
	})

	it("does not split ; inside double quotes", () => {
		const result = parseCommand('echo "a ; b"')
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("a ; b")
	})

	it("splits a three-command chain", () => {
		const result = parseCommand("cd /tmp && ls -la && echo done")
		expect(result).toHaveLength(3)
		expect(result[0]).toContain("cd")
		expect(result[1]).toContain("ls")
		expect(result[2]).toContain("echo done")
	})

	it("handles mixed chain operators", () => {
		const result = parseCommand("make build && make test || echo fail ; make clean")
		expect(result.length).toBe(4)
	})
})

// =============================================================================
// ENV=value command prefixes
// =============================================================================

describe("parseCommand — ENV=value prefixes", () => {
	it("treats ENV=value command as a single command", () => {
		const result = parseCommand("FOO=bar echo hello")
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("FOO=bar")
	})

	it("treats multiple ENV=value prefixes as a single command", () => {
		const result = parseCommand("CC=gcc CXX=g++ make build")
		expect(result).toHaveLength(1)
	})

	it("splits ENV=value command followed by chain operator", () => {
		const result = parseCommand("FOO=bar echo hello && echo done")
		expect(result.length).toBe(2)
	})
})

// =============================================================================
// Nested command substitution
// =============================================================================

describe("parseCommand — nested command substitution", () => {
	it("handles simple command substitution $(...)", () => {
		const result = parseCommand("echo $(whoami)")
		expect(result.length).toBeGreaterThanOrEqual(1)
	})

	it("handles nested command substitution $(echo $(whoami))", () => {
		const result = parseCommand("echo $(echo $(whoami))")
		// Should not crash and should produce at least one command
		expect(result.length).toBeGreaterThanOrEqual(1)
	})

	it("handles backtick substitution", () => {
		const result = parseCommand("echo `date`")
		expect(result.length).toBeGreaterThanOrEqual(1)
	})
})

// =============================================================================
// Commands with newlines inside quotes (the critical bug)
// =============================================================================

describe("parseCommand — newlines inside quotes", () => {
	it("does not split on newline inside double quotes", () => {
		const cmd = 'printf "hello\\nworld"'
		const result = parseCommand(cmd)
		expect(result).toHaveLength(1)
	})

	it("handles a real-world git commit with multiline message", () => {
		const cmd = `git commit -m "feat: add new feature

This commit adds the following:
- item one
- item two"`
		const result = parseCommand(cmd)
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("git commit")
	})

	it("handles python -c with multiline string", () => {
		const cmd = `python3 -c "
import sys
print('hello')
"`
		const result = parseCommand(cmd)
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("python3")
	})
})
