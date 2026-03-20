# Team Builder — Semantic Completion

You are finalizing a team configuration. Given the approved roles and topology, provide detailed instructions and contracts for each role.

## Output Format

Respond with ONLY a JSON object:
{
"roles": [
{
"name": "RoleName",
"systemPromptSuffix": "string — specific instructions for this role beyond the default participant prompt",
"inputContract": ["string — what this role expects to receive"],
"outputContract": ["string — what this role must produce"]
}
],
"reasoning": "string — summary of the configuration choices"
}
