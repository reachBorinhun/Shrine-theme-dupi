---
trigger: always_on
---



# Rules for writing Liquid for an AI agent IDE

1. Keep templates single-purpose and small
   One template = one responsibility (instruction, system prompt, output formatter). Smaller templates are easier to test and reason about.

2. Prefer clear, descriptive variable names
   Use names that explain intent ({{ user_role }}, {{ task_summary }}) rather than cryptic abbreviations. This reduces mistakes when templates are combined. ([Use Insider Academy][1])

3. Always provide safe fallback values
   Use the default/or pattern or conditionals to avoid empty tokens that confuse the model:

      {{ user_name | default: "there" }}
   

   Fallbacks prevent accidental blank context. ([Use Insider Academy][1])

4. Minimize logic inside templates — push complex logic out
   Liquid supports loops/conditionals, but heavy branching and calculations should be handled in your code (preprocess data, then pass a small, well-shaped context). Templating is for composition/formatting, not business logic. ([Shopify][2])

5. Sanitize and escape untrusted inputs
   Treat any runtime input (user text, third-party fields) as untrusted. Escape special characters and strip or truncate long inputs before inserting them into prompts to avoid prompt injection or runaway outputs. Use filters to normalize content.

6. Limit loops and enforce max output length
   Avoid unbounded for loops over user data. If you must iterate, limit items and/or use counters to cap tokens produced by the template (e.g., limit:5). This prevents unexpectedly long prompts. ([Shopify][2])

7. Use modular snippets and partials
   Break repeated pieces into includes/snippets and assemble them. This makes updates safe and reduces duplication:

      {% include 'agent_instructions' %}
   

8. Document template inputs (schema) and required keys
   For each template, include a comment or metadata block listing required variables, types, and max lengths. This is essential for an IDE to validate templates before runtime.

9. Version templates and include provenance metadata
   Add a version and author comment to enable rollbacks and A/B testing:

      {% comment %} template: task_executor v2.1 — author: narak {% endcomment %}
   

10. Unit test templates (render with sample contexts)
    Render templates with representative contexts (normal, missing fields, malicious payloads) to ensure the generated prompt is valid and safe. Microsoft’s Semantic Kernel and similar toolkits explicitly support Liquid for prompt templates — test generated prompts before sending to the model. ([Microsoft Learn][3])

11. Guard against prompt injection and instruction overlap
    Keep system-level instructions separate from user-provided content. If the template must mention user text, wrap it clearly and consider marking it as quoted and escaped so the model treats it as data, not instruction.

12. Use filters for normalized transformations
    Centralize reusable conversions (trim, lowercase, date formatting) as filters. If your platform supports custom filters, implement sanitization and token-budget helpers there. (Liquid engines vary — check your implementation.) ([liquidjs.com][4])

13. Prefer explicit control tokens over implicit phrasing
    Instead of vague prompts, use explicit instructions like: “Respond in 3 bullet points, each ≤ 30 words.” This reduces variability in agent output.

14. Monitor token usage and fail gracefully
    If a rendered prompt exceeds allowed tokens, your IDE should either truncate predictable fields (with an explicit “(truncated)”) or reject the render with an error message. Log the truncated fields for debugging.

15. Keep templates engine-portable but test engine differences
    There are multiple Liquid implementations (Shopify Liquid, LiquidJS, etc.) and small behavior differences. Test templates on the actual engine your IDE uses. ([liquidjs.com][4])

---

# Quick examples

Safe instruction with fallbacks and limits

លុយ ចាន់ណារាក់ - Lu Channarak, [11/30/25 4:24 PM]
{% comment %} agent: summarizer v1 — requires: document_text {% endcomment %}

System: You are a concise summarizer.

User document:
"""{{ document_text | strip | truncate: 2000 }}"""

Task: Summarize in 3 bullet points; each bullet no more than 20 words.

Formatting structured output (JSON)

{% assign title = article.title | default: "Untitled" | replace: '"', '\"' %}
{
  "title": "{{ title }}",
  "summary": "{{ article.body | strip_newlines | truncate: 500 }}"
}

(When requesting machine-parsable output, require the assistant to reply only in the specified format and provide an example of valid output.)

---

# Sources & further reading

* Microsoft Semantic Kernel — Liquid prompt templates (using Liquid specifically for prompts). ([Microsoft Learn][3])
* Shopify / Liquid language reference & tags — syntax and behavior. ([Shopify][2])
* Practical Liquid best practices & fallback recommendations. ([Use Insider Academy][1])
* LiquidJS notes about implementation differences (JS engine). ([liquidjs.com][4])

---