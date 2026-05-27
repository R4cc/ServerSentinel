import type { Notice, GeneralJob } from '../types';

export function Notifications({
  notices,
  activeJobs,
  onDismissJob
}: {
  notices: Notice[];
  activeJobs: GeneralJob[];
  onDismissJob: (id: string) => void;
}) {
  return (
    <div className="toastRegion">
      {activeJobs.map((job) => {
        const progress = Math.max(0, Math.min(100, job.progress));
        return (
          <div key={job.id} className={`toast provisioningToast ${job.status}`} role="status" aria-live="polite">
            <div className="provisioningToastHeader">
              <div>
                <strong>{job.title}</strong>
                <span>{job.status === "succeeded" ? "Complete" : job.status === "failed" ? "Failed" : "Running"}</span>
              </div>
              {job.dismissible && (
                <button
                  type="button"
                  className="toastDismissButton"
                  onClick={() => onDismissJob(job.id)}
                  aria-label={`Dismiss ${job.title} notification`}
                >
                  x
                </button>
              )}
            </div>
            {job.subject && (
              <p style={{ fontWeight: 800, margin: "2px 0 6px", textTransform: "none", letterSpacing: "normal", color: "var(--text)" }}>
                {job.subject}
              </p>
            )}
            <p>{job.error || job.task}</p>
            <div
              className="progressTrack"
              aria-label={`${job.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              role="progressbar"
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <small>{Math.round(progress)}%</small>
          </div>
        );
      })}
      {notices.map((notice) => (
        <div key={notice.id} className={`toast ${notice.type}`}>{notice.text}</div>
      ))}
    </div>
  );
}
