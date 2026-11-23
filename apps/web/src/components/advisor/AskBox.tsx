import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, Collapse, IconButton, InputAdornment, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswerOutlined';
import SendIcon from '@mui/icons-material/Send';
import CheckIcon from '@mui/icons-material/Check';
import AddIcon from '@mui/icons-material/Add';
import CodeIcon from '@mui/icons-material/Code';
import CloseIcon from '@mui/icons-material/Close';
import { errorMessage } from '@/api/client';
import { useAsk, type ASuggestion, type AskAnswer, type Understood } from '@/api/advisor';

const KIND_COLOR: Record<Understood['kind'], 'default' | 'primary' | 'secondary' | 'warning' | 'info' | 'success'> = {
  table: 'default',
  measure: 'primary',
  by: 'secondary',
  filter: 'warning',
  time: 'info',
  sort: 'success',
};
const KIND_LABEL: Record<Understood['kind'], string> = { table: 'From', measure: 'Measure', by: 'By', filter: 'Where', time: 'When', sort: 'Order' };

interface Props {
  analysisId: string;
  examples: string[];
  selected: string[];
  onAnswer: (s: ASuggestion) => void;
  onToggle: (id: string) => void;
  renderPreview: (s: ASuggestion) => ReactNode;
  onTeach: () => void;
}

/**
 * Plain-language questions, answered on the server from the analysed model (tables, joins, roles,
 * synonyms). Nothing is sent to an external service.
 */
export function AskBox({ analysisId, examples, selected, onAnswer, onToggle, renderPreview, onTeach }: Props) {
  const ask = useAsk();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const submit = (question = q, table?: string) => {
    const text = question.trim();
    if (text.length < 2) return;
    setQ(text);
    setShowSql(false);
    ask.mutate(
      { id: analysisId, question: text, table },
      {
        onSuccess: (r) => {
          setAnswer(r);
          if (r.ok) {
            onAnswer(r.suggestion);
            setHistory((h) => [text, ...h.filter((x) => x.toLowerCase() !== text.toLowerCase())].slice(0, 6));
          }
        },
      },
    );
  };

  const ok = answer?.ok ? answer : null;
  const added = ok ? selected.includes(ok.suggestion.id) : false;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'surface.panel' }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          fullWidth
          size="small"
          placeholder={`Ask a question, e.g. "${examples[0] ?? 'orders by region last 30 days'}"`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          inputProps={{ maxLength: 300, 'aria-label': 'Question' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <QuestionAnswerIcon fontSize="small" color="primary" />
              </InputAdornment>
            ),
          }}
        />
        <Button variant="contained" endIcon={<SendIcon />} onClick={() => submit()} disabled={ask.isPending || q.trim().length < 2} sx={{ flexShrink: 0 }}>
          Ask
        </Button>
      </Stack>
      <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }} alignItems="center">
        <Typography variant="caption" color="text.secondary">
          {history.length ? 'Recent:' : 'Try:'}
        </Typography>
        {(history.length ? history : examples).slice(0, 5).map((e) => (
          <Chip key={e} size="small" variant="outlined" label={e} onClick={() => submit(e)} sx={{ height: 22 }} />
        ))}
      </Stack>
      {ask.isPending && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Working it out…</Typography>}
      {ask.error && <Alert severity="error" sx={{ mt: 1.5 }}>{errorMessage(ask.error)}</Alert>}

      {answer && !answer.ok && !ask.isPending && (
        <Alert severity="warning" sx={{ mt: 1.5 }} onClose={() => setAnswer(null)}>
          <Typography variant="body2">{answer.message}</Typography>
          {answer.hints.length > 0 && (
            <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }} alignItems="center">
              <Typography variant="caption">Questions this database can answer:</Typography>
              {answer.hints.map((h) => (
                <Chip key={h} size="small" label={h} onClick={() => submit(h)} sx={{ height: 22 }} />
              ))}
            </Stack>
          )}
          <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
            Words for your tables or columns that Graphan doesn't know can be taught as synonyms.{' '}
            <Button size="small" onClick={onTeach} sx={{ p: 0, minWidth: 0, verticalAlign: 'baseline', textTransform: 'none' }}>
              Edit the data model
            </Button>
          </Typography>
        </Alert>
      )}

      {ok && !ask.isPending && (
        <Box sx={{ mt: 2, border: 1, borderColor: added ? 'primary.main' : 'divider', borderRadius: 1, p: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
                {ok.suggestion.title}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.5 }}>
                {ok.understood.map((u, i) => (
                  <Chip key={i} size="small" color={KIND_COLOR[u.kind]} variant={u.kind === 'table' ? 'outlined' : 'filled'} label={`${KIND_LABEL[u.kind]}: ${u.text}`} sx={{ height: 22 }} />
                ))}
              </Stack>
            </Box>
            <Tooltip title="How confident the interpretation is">
              <Chip size="small" label={`${ok.confidence}%`} color={ok.confidence >= 80 ? 'success' : ok.confidence >= 60 ? 'primary' : 'warning'} sx={{ height: 22, fontWeight: 600 }} />
            </Tooltip>
            <IconButton size="small" aria-label="Close answer" onClick={() => setAnswer(null)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          {ok.ignored.length > 0 && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.75 }}>
              Not understood: {ok.ignored.join(', ')}.{' '}
              <Button size="small" onClick={onTeach} sx={{ p: 0, minWidth: 0, verticalAlign: 'baseline', textTransform: 'none', fontSize: 'inherit' }}>
                Teach a synonym
              </Button>
            </Typography>
          )}
          {ok.notes.map((n) => (
            <Alert key={n} severity="info" sx={{ mt: 1, py: 0 }}>
              {n}
            </Alert>
          ))}
          {ok.alternatives.length > 0 && (
            <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }} alignItems="center">
              <Typography variant="caption" color="text.secondary">
                Answer from another table:
              </Typography>
              {ok.alternatives.map((x) => (
                <Chip key={x.table} size="small" variant="outlined" label={x.label} onClick={() => submit(q, x.table)} sx={{ height: 22 }} />
              ))}
            </Stack>
          )}
          <Box sx={{ mt: 1.5 }}>{renderPreview(ok.suggestion)}</Box>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
            <Button variant={added ? 'outlined' : 'contained'} size="small" startIcon={added ? <CheckIcon /> : <AddIcon />} onClick={() => onToggle(ok.suggestion.id)}>
              {added ? 'In selection' : 'Add to selection'}
            </Button>
            <Button size="small" startIcon={<CodeIcon />} onClick={() => setShowSql((v) => !v)}>
              {showSql ? 'Hide SQL' : 'Show SQL'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              {ok.suggestion.preview?.rows.length ?? 0} row{ok.suggestion.preview?.rows.length === 1 ? '' : 's'}
            </Typography>
          </Stack>
          <Collapse in={showSql} unmountOnExit>
            <Box component="pre" sx={{ mt: 1, p: 1.25, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre', fontFamily: '"JetBrains Mono", Consolas, monospace' }}>
              {ok.sql}
            </Box>
          </Collapse>
        </Box>
      )}
    </Paper>
  );
}
