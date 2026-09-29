'use client';

import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';
import { useRef, useState } from 'react';

interface Props {
  runId: string;
  state: 'OPEN' | 'RESOLVED';
  version: number;
  sourceIds: string[];
}

export function ReviewForm({ runId, state, version, sourceIds }: Props) {
  const router = useRouter();
  const [action, setAction] = useState('RESOLVE_MANUALLY');
  const [reason, setReason] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingRequest = useRef<{ signature: string; requestId: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const command = {
      action: state === 'RESOLVED' ? 'REOPEN' : action,
      reason: reason.trim(),
      sourceIds: selectedSources,
      expectedVersion: version,
    };
    const signature = JSON.stringify(command);
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, requestId: crypto.randomUUID() };
    }
    try {
      const response = await fetch(`/api/tenders/${encodeURIComponent(runId)}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...command, requestId: pendingRequest.current.requestId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        if (response.status === 409) {
          pendingRequest.current = null;
          router.refresh();
        }
        throw new Error(body.error ?? `Request failed (${response.status}).`);
      }
      pendingRequest.current = null;
      setReason('');
      setSelectedSources([]);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record review action.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="review-form" onSubmit={submit}>
      {state === 'OPEN' ? (
        <>
          <label>
            Disposition
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="RESOLVE_MANUALLY">Resolve manually</option>
              <option value="REQUEST_INFORMATION">Request information</option>
              <option value="CONFIRM_DUPLICATE">Confirm duplicate</option>
            </select>
          </label>
          <label>
            Decision reason
            <textarea
              required
              maxLength={4000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain the determination and the evidence considered."
            />
          </label>
          {sourceIds.length > 0 ? (
            <fieldset className="source-picker">
              <legend>Evidence considered</legend>
              {sourceIds.map((sourceId) => (
                <label key={sourceId}>
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(sourceId)}
                    onChange={(event) =>
                      setSelectedSources((current) =>
                        event.target.checked
                          ? [...current, sourceId]
                          : current.filter((item) => item !== sourceId),
                      )
                    }
                  />
                  {sourceId}
                </label>
              ))}
            </fieldset>
          ) : null}
          <button className="primary-button" disabled={busy || reason.trim().length === 0}>
            {busy ? 'Saving…' : 'Record decision'}
          </button>
        </>
      ) : (
        <>
          <label>
            Reason for reopening
            <textarea
              required
              maxLength={4000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain why this case needs review again."
            />
          </label>
          <button className="secondary-button" disabled={busy || reason.trim().length === 0}>
            {busy ? 'Saving…' : 'Reopen review'}
          </button>
        </>
      )}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <small className="action-note">
        A review disposition is an audit record. It does not change the automatic route or send the
        tender to pricing.
      </small>
    </form>
  );
}
