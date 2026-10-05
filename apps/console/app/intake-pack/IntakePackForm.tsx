'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  INTAKE_PACK_ENTRY_NAME,
  INTAKE_PACK_FLOW_STEPS,
  INTAKE_PACK_LIMITS,
  buildIntakeFileRows,
  canRemoveIntakeFileRow,
  canRetryIntakeFileRow,
  canTriggerIntakeExtract,
  classifyLocalIntakeFile,
  currentIntakePackFlowStep,
  displayIntakeStatus,
  encodeIntakeFileNameHeader,
  failedIntakeFileRows,
  formatIntakeBytes,
  intakePackLimitSummary,
  intakeStatusTone,
  intakeUploadBodyCapBytes,
  type IntakeApiErrorBody,
  type IntakeFileRow,
  type IntakePackView,
  type LocalIntakeFile,
} from '../../src/intake-pack';

interface Props {
  initialPackId?: string;
}

export function IntakePackForm({ initialPackId }: Props) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const filesByLocalId = useRef(new Map<string, File>());
  const packRef = useRef<IntakePackView | null>(null);
  const notesDirtyRef = useRef(false);
  const createPackPromise = useRef<Promise<IntakePackView> | null>(null);
  const [pack, setPack] = useState<IntakePackView | null>(null);
  const [localFiles, setLocalFiles] = useState<LocalIntakeFile[]>([]);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(initialPackId));
  const [uploading, setUploading] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const rows = useMemo(
    () => buildIntakeFileRows(pack ?? undefined, localFiles),
    [pack, localFiles],
  );
  const failedRows = useMemo(() => failedIntakeFileRows(rows), [rows]);
  const flowStep = currentIntakePackFlowStep(pack ?? undefined);
  const canExtract = canTriggerIntakeExtract({
    pack: pack ?? undefined,
    localFiles,
    extracting,
  });

  const applyPack = useCallback((next: IntakePackView) => {
    packRef.current = next;
    setPack(next);
    setNotes((current) => {
      if (notesDirtyRef.current) return current;
      return next.notes[0]?.text ?? '';
    });
  }, []);

  const loadPack = useCallback(
    async (packId: string) => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`/api/intake-packs/${encodeURIComponent(packId)}`, {
          cache: 'no-store',
        });
        const body = await readJson<IntakePackView & IntakeApiErrorBody>(response);
        if (!response.ok) {
          throw new Error(
            body.message ?? body.error ?? `Unable to load ${INTAKE_PACK_ENTRY_NAME}.`,
          );
        }
        applyPack(body);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : `Unable to load ${INTAKE_PACK_ENTRY_NAME}.`,
        );
      } finally {
        setLoading(false);
      }
    },
    [applyPack],
  );

  useEffect(() => {
    if (initialPackId) void loadPack(initialPackId);
  }, [initialPackId, loadPack]);

  const ensurePack = useCallback(async (): Promise<IntakePackView> => {
    if (packRef.current) return packRef.current;
    if (createPackPromise.current) return createPackPromise.current;
    createPackPromise.current = (async () => {
      const response = await fetch('/api/intake-packs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ synthetic: true }),
      });
      const body = await readJson<IntakePackView & IntakeApiErrorBody>(response);
      if (!response.ok) {
        throw new Error(
          body.message ?? body.error ?? `Unable to create ${INTAKE_PACK_ENTRY_NAME}.`,
        );
      }
      applyPack(body);
      router.replace(`/intake-pack/${encodeURIComponent(body.packId)}`);
      return body;
    })();
    try {
      return await createPackPromise.current;
    } finally {
      createPackPromise.current = null;
    }
  }, [applyPack, router]);

  const uploadOne = useCallback(
    async (localId: string, target: IntakePackView): Promise<IntakePackView> => {
      const file = filesByLocalId.current.get(localId);
      if (!file) return target;

      setLocalFiles((items) =>
        items.map((item) => (item.localId === localId ? { ...item, phase: 'uploading' } : item)),
      );

      const payload = await readCappedBlob(file);
      const bytes = new Uint8Array(await payload.arrayBuffer());
      const previewFailure = classifyLocalIntakeFile({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        byteSize: file.size,
        bytes,
      });
      const response = await fetch(
        `/api/intake-packs/${encodeURIComponent(target.packId)}/documents`,
        {
          method: 'POST',
          headers: {
            'content-type': file.type || 'application/pdf',
            'x-file-name': encodeIntakeFileNameHeader(file.name),
          },
          body: payload,
        },
      );
      const body = await readJson<
        IntakeApiErrorBody & { documentId?: string; failure?: IntakeApiErrorBody['failure'] }
      >(response);
      if (response.status === 409 && body.pack) {
        applyPack(body.pack);
        setLocalFiles((items) =>
          items.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  phase: 'rejected',
                  failure: body.failure ?? {
                    code: body.error ?? 'PACK_FILE_COUNT',
                    message: body.message ?? 'This file was not added to the pack.',
                    retryable: false,
                  },
                }
              : item,
          ),
        );
        return body.pack;
      }
      if (!response.ok) {
        const failure = {
          code:
            body.failure?.code ??
            body.error ??
            (response.status === 413 ? 'OVERSIZED' : 'UPLOAD_FAILED'),
          message:
            body.failure?.message ??
            body.message ??
            (response.status === 413
              ? `File exceeds the ${formatIntakeBytes(INTAKE_PACK_LIMITS.maxFileBytes)} per-file limit.`
              : `Upload failed (${response.status}).`),
          retryable: response.status >= 500 || response.status === 0,
        };
        setLocalFiles((items) =>
          items.map((item) =>
            item.localId === localId ? { ...item, phase: 'failed', failure } : item,
          ),
        );
        return target;
      }

      const refreshed = await fetch(`/api/intake-packs/${encodeURIComponent(target.packId)}`, {
        cache: 'no-store',
      });
      const nextPack = await readJson<IntakePackView & IntakeApiErrorBody>(refreshed);
      if (refreshed.ok) applyPack(nextPack);
      setLocalFiles((items) =>
        items.map((item) =>
          item.localId === localId
            ? {
                ...item,
                phase: 'registered',
                documentId: body.documentId,
                failure: body.failure ?? previewFailure,
              }
            : item,
        ),
      );
      filesByLocalId.current.delete(localId);
      return refreshed.ok ? nextPack : target;
    },
    [applyPack],
  );

  const queueFiles = useCallback(
    async (fileList: File[]) => {
      if (fileList.length === 0) return;
      setError('');
      const additions: LocalIntakeFile[] = fileList.map((file) => {
        const localId = crypto.randomUUID();
        filesByLocalId.current.set(localId, file);
        return {
          localId,
          fileName: file.name,
          byteSize: file.size,
          contentType: file.type || 'application/octet-stream',
          phase: 'queued',
        };
      });
      setLocalFiles((current) => [...current, ...additions]);
      setUploading(true);
      try {
        let currentPack = await ensurePack();
        for (const item of additions) {
          currentPack = await uploadOne(item.localId, currentPack);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to register files.');
      } finally {
        setUploading(false);
      }
    },
    [ensurePack, uploadOne],
  );

  const retryFile = useCallback(
    async (row: IntakeFileRow) => {
      if (!canRetryIntakeFileRow(row)) return;
      setError('');
      setUploading(true);
      try {
        const currentPack = await ensurePack();
        await uploadOne(row.key, currentPack);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Retry failed.');
      } finally {
        setUploading(false);
      }
    },
    [ensurePack, uploadOne],
  );

  const removeFile = useCallback((row: IntakeFileRow) => {
    if (!canRemoveIntakeFileRow(row)) return;
    filesByLocalId.current.delete(row.key);
    setLocalFiles((items) => items.filter((item) => item.localId !== row.key));
  }, []);

  const saveNotes = useCallback(async (): Promise<boolean> => {
    const text = notes.trim();
    if (!text) {
      setError('Broker notes must contain text before they can be saved.');
      return false;
    }
    setSavingNotes(true);
    setError('');
    try {
      const currentPack = await ensurePack();
      const response = await fetch(
        `/api/intake-packs/${encodeURIComponent(currentPack.packId)}/notes`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
      const body = await readJson<
        { packId: string; notes: IntakePackView['notes'] } & IntakeApiErrorBody
      >(response);
      if (!response.ok) {
        throw new Error(
          body.failure?.message ?? body.message ?? body.error ?? 'Unable to save notes.',
        );
      }
      notesDirtyRef.current = false;
      setNotesDirty(false);
      const refreshed = await fetch(`/api/intake-packs/${encodeURIComponent(currentPack.packId)}`, {
        cache: 'no-store',
      });
      const nextPack = await readJson<IntakePackView>(refreshed);
      if (refreshed.ok) applyPack(nextPack);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save notes.');
      return false;
    } finally {
      setSavingNotes(false);
    }
  }, [applyPack, ensurePack, notes]);

  const extract = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canExtract || !pack) return;
      setExtracting(true);
      setError('');
      try {
        if (notesDirty && notes.trim()) {
          const saved = await saveNotes();
          if (!saved) return;
        }
        const response = await fetch(
          `/api/intake-packs/${encodeURIComponent(pack.packId)}/extractions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        );
        const body = await readJson<IntakeApiErrorBody>(response);
        if (body.pack) applyPack(body.pack);
        if (!response.ok) {
          throw new Error(
            body.failure?.message ??
              body.message ??
              body.error ??
              'Extraction did not complete. Failed files remain listed.',
          );
        }
        const refreshed = await fetch(`/api/intake-packs/${encodeURIComponent(pack.packId)}`, {
          cache: 'no-store',
        });
        const nextPack = await readJson<IntakePackView>(refreshed);
        if (refreshed.ok) applyPack(nextPack);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Extraction failed.');
      } finally {
        setExtracting(false);
      }
    },
    [applyPack, canExtract, notes, notesDirty, pack, saveNotes],
  );

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    void queueFiles([...event.dataTransfer.files]);
  }

  return (
    <>
      <ol className="intake-flow" aria-label={`${INTAKE_PACK_ENTRY_NAME} steps`}>
        {INTAKE_PACK_FLOW_STEPS.map((step) => {
          const current = step.id === flowStep;
          const later = step.id === 'review' || step.id === 'confirm' || step.id === 'assess';
          return (
            <li
              key={step.id}
              className={`intake-flow-step${current ? ' current' : ''}${later ? ' later' : ''}`}
            >
              <strong>{step.label}</strong>
              {later ? <small>Later ticket</small> : null}
            </li>
          );
        })}
      </ol>

      {loading ? (
        <div className="notice notice-info">
          <strong>Loading pack</strong>
          <span>Fetching the registered {INTAKE_PACK_ENTRY_NAME} from the local API.</span>
        </div>
      ) : null}

      {pack ? (
        <div className="stat-grid intake-stats">
          <article className="stat-card">
            <span>Pack status</span>
            <strong className="intake-status-value">
              <span className={`pill ${intakeStatusTone(pack.status)}`}>
                {displayIntakeStatus(pack.status)}
              </span>
            </strong>
            <small>{pack.packId}</small>
          </article>
          <article className="stat-card">
            <span>Registered files</span>
            <strong>{pack.documents.length}</strong>
            <small>
              {pack.documents.length} of {INTAKE_PACK_LIMITS.maxDocuments} ·{' '}
              {formatIntakeBytes(
                pack.documents.reduce((sum, document) => sum + document.byteSize, 0),
              )}{' '}
              of {formatIntakeBytes(INTAKE_PACK_LIMITS.maxPackBytes)}
            </small>
          </article>
          <article className="stat-card">
            <span>Visible failures</span>
            <strong>{failedRows.length}</strong>
            <small>Failed files stay on the list; they are not omitted.</small>
          </article>
        </div>
      ) : null}

      {pack?.failure ? (
        <div className={`notice ${pack.failure.retryable ? 'notice-warning' : 'notice-error'}`}>
          <strong>{displayIntakeStatus(pack.failure.code)}</strong>
          <span>
            {pack.failure.message}{' '}
            {pack.failure.retryable
              ? 'This pack-level failure is retryable.'
              : 'This pack-level failure is terminal.'}
          </span>
        </div>
      ) : null}

      <section className="panel intake-panel">
        <div className="panel-heading">
          <div>
            <h2>PDFs</h2>
            <p>{intakePackLimitSummary()}</p>
          </div>
        </div>
        <div
          className={`drop-zone${dragActive ? ' active' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInput.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Drop synthetic PDFs or choose files"
        >
          <strong>Drop synthetic PDFs here</strong>
          <p>
            PDF is the accepted upload type. Unsupported or oversized files are still listed with an
            error so nothing fails silently.
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={(event) => {
              event.stopPropagation();
              fileInput.current?.click();
            }}
            disabled={uploading || extracting}
          >
            Choose files
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            multiple
            onChange={(event) => {
              void queueFiles([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Status</th>
                <th>Detail</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong>{row.fileName}</strong>
                    <small className="subline">
                      {row.documentId ? `Document ${row.documentId}` : 'Not registered yet'}
                      {row.pageCount !== undefined ? ` · ${row.pageCount} pages` : ''}
                    </small>
                  </td>
                  <td>{formatIntakeBytes(row.byteSize)}</td>
                  <td>
                    <span className={`pill ${intakeStatusTone(row.status)}`}>
                      {displayIntakeStatus(row.status)}
                    </span>
                  </td>
                  <td className="intake-detail-cell">
                    {row.failure ? (
                      <>
                        <strong>{displayIntakeStatus(row.failure.code)}</strong>
                        <span>{row.failure.message}</span>
                      </>
                    ) : (
                      <span className="muted">{row.source === 'pack' ? 'On pack' : 'Waiting'}</span>
                    )}
                  </td>
                  <td>
                    <div className="file-actions">
                      {canRetryIntakeFileRow(row) ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={uploading || extracting}
                          onClick={() => void retryFile(row)}
                        >
                          Retry
                        </button>
                      ) : null}
                      {canRemoveIntakeFileRow(row) ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={uploading || extracting}
                          onClick={() => removeFile(row)}
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="muted">Kept</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="empty-cell" colSpan={5}>
                    No files yet. Drop PDFs to start an {INTAKE_PACK_ENTRY_NAME} without filling a
                    tender form.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="fine-print intake-keep-note">
          Registered files stay on this pack, including {displayIntakeStatus('OCR_REQUIRED')},{' '}
          {displayIntakeStatus('CORRUPT')}, {displayIntakeStatus('UNSUPPORTED')},{' '}
          {displayIntakeStatus('OVERSIZED')}, and {displayIntakeStatus('EXTRACTION_FAILED')}. Remove
          is only available before registration succeeds, or for a local rejection that never joined
          the pack. Start a new pack to begin again.
        </p>
      </section>

      <div className="two-column intake-lower">
        <section className="detail-card">
          <h2>Broker notes</h2>
          <p className="source-copy">
            One pasted notes field. Notes are optional until you save them. They do not fill
            structured tender fields.
          </p>
          <form
            className="review-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveNotes();
            }}
          >
            <label>
              Broker notes
              <textarea
                maxLength={INTAKE_PACK_LIMITS.maxNoteChars}
                value={notes}
                onChange={(event) => {
                  notesDirtyRef.current = true;
                  setNotesDirty(true);
                  setNotes(event.target.value);
                }}
                placeholder="Paste synthetic broker notes. This is the only unstructured text field on Intake pack."
              />
            </label>
            <small className="action-note">
              {notes.length.toLocaleString('en-GB')} /{' '}
              {INTAKE_PACK_LIMITS.maxNoteChars.toLocaleString('en-GB')} characters
            </small>
            <button
              className="secondary-button"
              disabled={savingNotes || notes.trim().length === 0}
            >
              {savingNotes ? 'Saving…' : 'Save notes'}
            </button>
          </form>
        </section>
        <section className="detail-card">
          <h2>Extract</h2>
          <p className="source-copy">
            Extraction reads selectable PDF text only. Scanned pages become OCR_REQUIRED. This
            Console slice stops at processing status — draft review, confirm, and readiness are
            later tickets.
          </p>
          {pack?.extraction ? (
            <div className="notice notice-info">
              <strong>Extraction stored</strong>
              <span>
                {pack.extraction.pages.length} page
                {pack.extraction.pages.length === 1 ? '' : 's'} ·{' '}
                {pack.extraction.pages
                  .reduce((sum, page) => sum + page.charCount, 0)
                  .toLocaleString('en-GB')}{' '}
                characters. Immutable evidence is saved. Draft preparation is not available on this
                page.
              </span>
            </div>
          ) : null}
          <form className="review-form" onSubmit={extract}>
            <button className="primary-button" disabled={!canExtract}>
              {extracting
                ? 'Extracting…'
                : pack?.extraction
                  ? 'Already extracted'
                  : 'Extract selectable text'}
            </button>
            <small className="action-note">
              Extract never calls pricing and never fills a tender form. A later review step will
              sit on this evidence.
            </small>
          </form>
          <p>
            <Link className="text-link" href="/intake-pack">
              Start a new {INTAKE_PACK_ENTRY_NAME}
            </Link>
          </p>
        </section>
      </div>

      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <p className="fine-print">
        Local demonstration using synthetic tender data. {INTAKE_PACK_ENTRY_NAME} registration does
        not create a pricing handoff.
      </p>
    </>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

async function readCappedBlob(file: File): Promise<Blob> {
  const cap = intakeUploadBodyCapBytes();
  return file.size > cap ? file.slice(0, cap) : file;
}
