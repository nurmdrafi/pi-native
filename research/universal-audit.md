# Universal Feature Audit & Implementation Planning

Act as a Principal Software Architect, Senior Security Engineer, Performance Engineer, and Staff Software Engineer.

Perform a comprehensive, evidence-based audit of the specified feature, module, or workflow within this repository.

## Audit Scope

Feature / Module / Workflow: [FEATURE_NAME]

Optional context:
[DESCRIBE THE FEATURE AND ITS EXPECTED BEHAVIOR]

Audit the target feature and all related dependencies, integrations, shared utilities, data flows, and execution paths that materially affect its behavior.

Do not unnecessarily audit unrelated modules.

## 1. Understand Before Auditing

- Inspect repository architecture and development conventions.
- Identify the feature's entry points and execution flow.
- Trace dependencies and module boundaries.
- Understand expected versus actual behavior.
- Inspect related tests, configurations, documentation, and Git history.
- Identify upstream and downstream dependencies.

Do not assume undocumented behavior.

## 2. Comprehensive Audit

Evaluate the feature across all applicable dimensions:

### Architecture
- Separation of concerns.
- Module boundaries.
- Coupling and cohesion.
- Abstraction quality.
- Design patterns.
- Extensibility.
- Scalability.
- Dependency direction.

### Security
- Authentication and authorization.
- Input validation.
- Injection vulnerabilities.
- Sensitive data exposure.
- Secrets management.
- API security.
- Dependency vulnerabilities.
- Trust boundaries.
- Relevant OWASP risks.

### Performance
- CPU and memory usage.
- Expensive operations.
- Network requests.
- Database queries.
- Rendering and computation.
- Caching.
- Concurrency.
- Resource cleanup.
- Scalability bottlenecks.

### Bugs and Correctness
- Incorrect business logic.
- Edge cases.
- Null and undefined handling.
- Race conditions.
- Async execution errors.
- State inconsistencies.
- Invalid assumptions.
- Error propagation.
- Boundary conditions.

### Data Integrity
- Data validation.
- Schema consistency.
- Persistence.
- Transaction handling.
- Duplicate processing.
- Data corruption.
- Migration compatibility.

### Reliability
- Error handling.
- Retry strategies.
- Timeouts.
- Recovery mechanisms.
- Idempotency.
- Partial failures.
- Logging and observability.

### Maintainability
- Code duplication.
- Complexity.
- Type safety.
- Dead code.
- Naming consistency.
- Documentation.
- Testability.

### Testing
- Existing test coverage.
- Missing test scenarios.
- Unit tests.
- Integration tests.
- End-to-end tests.
- Regression risks.

Only apply relevant dimensions. Explain why any dimension is not applicable.

## 3. Validate Findings

Use available repository tools where appropriate:

- Tests.
- Type checking.
- Linting.
- Build validation.
- Static analysis.
- Security scanning.
- Dependency auditing.
- Benchmarks.

Do not claim an issue exists without supporting evidence.

For each finding, provide:

- Unique finding ID.
- Category.
- Severity: Critical / High / Medium / Low / Informational.
- Confidence: Confirmed / Probable / Potential.
- Affected files and line references.
- Evidence.
- Technical explanation.
- Impact.
- Recommended solution.
- Validation method.

Clearly distinguish verified defects from potential risks and improvement opportunities.

## 4. Prioritize Findings

Use:

- P0: Critical security, data integrity, or production-blocking issues.
- P1: High-impact functional, architectural, or reliability issues.
- P2: Important improvements.
- P3: Maintainability and optimization.
- P4: Optional enhancements.

Prioritize by impact, likelihood, implementation complexity, and dependencies.

## 5. Generate Implementation Plan

Create actionable implementation phases.

For each task, include:

- Task ID.
- Title.
- Priority.
- Related finding IDs.
- Problem statement.
- Proposed implementation.
- Affected files/modules.
- Dependencies.
- Acceptance criteria.
- Testing requirements.
- Regression risks.
- Complexity: S / M / L / XL.

Identify:
- Recommended execution order.
- Parallelizable tasks.
- Sequential dependencies.
- Breaking changes.
- Migration requirements.
- Rollback strategy.

Do not recommend unnecessary refactoring or dependencies.

## 6. Save Deliverables

Create:

1. `docs/audit/[FEATURE_NAME]/COMPREHENSIVE_AUDIT.md`
2. `docs/audit/[FEATURE_NAME]/IMPLEMENTATION_PLAN.md`
3. `docs/audit/[FEATURE_NAME]/IMPLEMENTATION_CHECKLIST.md`
4. `docs/audit/[FEATURE_NAME]/ARCHITECTURE_REVIEW.md`

Inspect existing documents before overwriting anything. Preserve previous audit history.

## 7. Operating Constraints

- Audit only; do not implement fixes.
- Do not modify application source code.
- Do not change production configuration.
- Do not delete files.
- Do not install unnecessary dependencies.
- Do not invent metrics or findings.
- Do not make unsupported assumptions.
- Follow existing repository conventions.
- Use targeted inspection rather than reading the entire codebase indiscriminately.
- Only create or update audit documentation.

## 8. Final Report

Summarize:

1. Feature overview and actual execution flow.
2. Overall audit assessment.
3. Findings by severity.
4. Critical issues.
5. Architectural weaknesses.
6. Security and performance risks.
7. Recommended implementation order.
8. Generated document paths.
9. Unverified areas.

Begin with repository discovery. Complete the audit and validation before generating the implementation plan.