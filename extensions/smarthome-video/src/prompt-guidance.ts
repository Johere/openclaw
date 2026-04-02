export function buildSmartHomeGuidance(monitors: { sourceId: string; name: string }[]): string {
  const monitorList = monitors
    .map((m) => `- ${m.sourceId}: ${m.name}`)
    .join("\n");

  return `## Smart Home Video Monitoring

You have access to smart home video monitoring tools. Available monitors:
${monitorList}

### Tools
- **video_db**: Query the monitoring database (events, tasks, summaries, stats, custom SQL).
- **monitor_ctl**: List monitors and check their status (VLM service health).
- **daily_report**: Generate or save daily monitoring reports.

### Database Schema
- **recordings**: Continuous video recording files (5min segments, rolling storage).
- **events**: Motion detection events with start/end timestamps.
- **tasks**: VLM analysis tasks linked to motion events, containing video summaries.
- **reports**: Archived daily reports.

### Usage Tips
- Use \`video_db\` with action='stats' to get an overview of a monitor.
- Use \`video_db\` with action='query' for custom SQL when the predefined actions don't fit.
- Use \`daily_report\` without report_text to gather raw summaries, then compose and save with report_text.
- All timestamps are ISO 8601 format.
`;
}
