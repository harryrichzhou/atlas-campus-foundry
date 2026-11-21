-- Agent Switch keeps recovery attempts on the same durable job. Detailed
-- handoff history remains append-only in job_events.
ALTER TABLE jobs ADD COLUMN agent_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN switch_count integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN current_agent text NOT NULL DEFAULT 'builder';

CREATE TABLE agent_attempts (
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  agent text NOT NULL,
  provider text NOT NULL,
  model text,
  trigger text NOT NULL,
  status text NOT NULL,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY(job_id, attempt)
);

CREATE INDEX agent_attempts_job_started
  ON agent_attempts(job_id, started_at);
