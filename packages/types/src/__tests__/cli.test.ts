import {
	rooCliApprovalRequestEventSchema,
	rooCliControlEventSchema,
	rooCliFinalOutputSchema,
	rooCliInputCommandSchema,
	rooCliStreamEventSchema,
} from "../cli.js"

describe("CLI types", () => {
	describe("rooCliInputCommandSchema", () => {
		it("validates a start command", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "start",
				requestId: "req-1",
				prompt: "hello",
				taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
				images: ["data:image/png;base64,abc"],
				configuration: {},
			})

			expect(result.success).toBe(true)
		})

		it("validates a message command with images", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "message",
				requestId: "req-2a",
				prompt: "follow up",
				images: ["data:image/png;base64,xyz"],
			})

			expect(result.success).toBe(true)
		})

		it("rejects a message command without prompt", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "message",
				requestId: "req-2",
			})

			expect(result.success).toBe(false)
		})

		it("rejects a start command with invalid taskId format", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "start",
				requestId: "req-invalid-task-id",
				prompt: "hello",
				taskId: "task-123",
			})

			expect(result.success).toBe(false)
		})
	})

	describe("rooCliControlEventSchema", () => {
		it("validates a control done event", () => {
			const result = rooCliControlEventSchema.safeParse({
				type: "control",
				subtype: "done",
				requestId: "req-3",
				command: "start",
				success: true,
				code: "task_completed",
			})

			expect(result.success).toBe(true)
		})

		it("rejects control event without requestId", () => {
			const result = rooCliControlEventSchema.safeParse({
				type: "control",
				subtype: "ack",
			})

			expect(result.success).toBe(false)
		})

		it("accepts approval_request as a valid control subtype", () => {
			const result = rooCliControlEventSchema.safeParse({
				type: "control",
				subtype: "approval_request",
				requestId: "req-4",
				approvalId: "approval-1",
				code: "tool",
				command: "approve",
				content: "approve tool: read_file",
			})

			expect(result.success).toBe(true)
		})
	})

	describe("rooCliApprovalRequestEventSchema", () => {
		it("validates a well-formed approval_request event", () => {
			const result = rooCliApprovalRequestEventSchema.safeParse({
				type: "control",
				subtype: "approval_request",
				approvalId: "approval-1",
				code: "tool",
				command: "approve",
				content: "approve tool: read_file",
				payload: '{"tool":"read_file"}',
				taskId: "task-42",
			})

			expect(result.success).toBe(true)
		})

		it("rejects approval_request missing approvalId", () => {
			const result = rooCliApprovalRequestEventSchema.safeParse({
				type: "control",
				subtype: "approval_request",
				code: "tool",
				command: "approve",
			})

			expect(result.success).toBe(false)
		})

		it("rejects approval_request with empty approvalId", () => {
			const result = rooCliApprovalRequestEventSchema.safeParse({
				type: "control",
				subtype: "approval_request",
				approvalId: "",
				code: "tool",
				command: "approve",
			})

			expect(result.success).toBe(false)
		})

		it("rejects approval_request missing code", () => {
			const result = rooCliApprovalRequestEventSchema.safeParse({
				type: "control",
				subtype: "approval_request",
				approvalId: "approval-1",
				command: "approve",
			})

			expect(result.success).toBe(false)
		})

		it("rejects approval_request with wrong subtype", () => {
			const result = rooCliApprovalRequestEventSchema.safeParse({
				type: "control",
				subtype: "done",
				approvalId: "approval-1",
				code: "tool",
				command: "approve",
			})

			expect(result.success).toBe(false)
		})

		it("accepts optional payload and taskId fields", () => {
			const result = rooCliApprovalRequestEventSchema.safeParse({
				type: "control",
				subtype: "approval_request",
				approvalId: "approval-5",
				code: "command",
				command: "approve",
			})

			expect(result.success).toBe(true)
		})
	})

	describe("rooCliInputCommandSchema — approvalId", () => {
		it("accepts approve command with approvalId", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "approve",
				requestId: "req-1",
				approvalId: "approval-3",
			})

			expect(result.success).toBe(true)
			if (result.success) {
				expect((result.data as { approvalId?: string }).approvalId).toBe("approval-3")
			}
		})

		it("accepts reject command with approvalId", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "reject",
				requestId: "req-1",
				approvalId: "approval-3",
			})

			expect(result.success).toBe(true)
		})

		it("accepts respond command with approvalId", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "respond",
				requestId: "req-1",
				text: "my response",
				approvalId: "approval-3",
			})

			expect(result.success).toBe(true)
		})

		it("accepts approve command without approvalId (backward compat)", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "approve",
				requestId: "req-1",
			})

			expect(result.success).toBe(true)
		})

		it("rejects approve command with empty approvalId", () => {
			const result = rooCliInputCommandSchema.safeParse({
				command: "approve",
				requestId: "req-1",
				approvalId: "",
			})

			expect(result.success).toBe(false)
		})
	})

	describe("rooCliStreamEventSchema", () => {
		it("accepts passthrough fields for forward compatibility", () => {
			const result = rooCliStreamEventSchema.safeParse({
				type: "assistant",
				id: 42,
				content: "partial",
				customField: "future",
			})

			expect(result.success).toBe(true)
		})
	})

	describe("rooCliFinalOutputSchema", () => {
		it("validates final json output shape", () => {
			const result = rooCliFinalOutputSchema.safeParse({
				type: "result",
				success: true,
				content: "done",
				events: [],
			})

			expect(result.success).toBe(true)
		})
	})
})
