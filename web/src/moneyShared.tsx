import { Form, Input, InputNumber, Modal, Radio, message } from 'antd'
import { useEffect, useState } from 'react'
import { api, auth } from './api'
import { useSelection } from './selection'
import type { Receipt } from './receipt'

export const today = () => new Date().toISOString().slice(0, 10)

// enrollmentId is what vouchers / renewals / arrears are keyed on; the roster only has it if the API returns it.
export type RosterRow = { id: number; admissionNo: string; name: string; enrollment: { className: string; enrollmentId?: number } }

// ponytail: loads the year's roster (API caps at 500) and filters client-side, same as CollectFee.
export function useRoster() {
  const { schoolId, yearId } = useSelection()
  const [roster, setRoster] = useState<RosterRow[]>([])
  useEffect(() => {
    if (!schoolId || !yearId) return
    api<RosterRow[]>(`/students?schoolId=${schoolId}&yearId=${yearId}`).then(setRoster).catch((e) => message.error(e.message))
  }, [schoolId, yearId])
  const options = roster.map((s) => ({ value: s.id, label: `${s.admissionNo} · ${s.name} · ${s.enrollment.className}` }))
  const enrollmentIdOf = (studentId: number) => {
    const id = roster.find((s) => s.id === studentId)?.enrollment.enrollmentId
    if (!id) throw new Error('The students API does not return enrollmentId yet; add it to GET /students')
    return id
  }
  return { roster, options, enrollmentIdOf }
}

// Like api() but never throws, so callers can read structured error bodies (e.g. import row errors).
export async function apiRaw(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}`, ...init.headers },
  })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) }
}

// Authed file download (CSV endpoints need the Bearer header, so a plain link won't do).
export async function downloadFile(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${auth.token}` } })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? res.statusText)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(await res.blob())
  a.download = filename
  a.click()
}

// Minimal CSV reader: quoted cells, "" escapes, CRLF. Returns rows of cells.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"', i++)
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') (row.push(cell), (cell = ''))
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim())) rows.push(row)
  return rows
}

export const qs = (o: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()

// CLEARED / BOUNCED a non-cash receipt. Used by Receipts and Banking.
export function ReconcileModal({ receipt, onClose, onDone }: { receipt: Receipt | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm()
  const status = Form.useWatch('status', form)
  useEffect(() => {
    if (receipt) form.setFieldsValue({ status: receipt.clearStatus === 'CLEARED' ? 'BOUNCED' : 'CLEARED', bankDate: today(), bounceCharge: undefined })
  }, [receipt])

  async function save(v: { status: string; bankDate?: string; bounceCharge?: number }) {
    try {
      await api(`/payments/${receipt!.id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ status: v.status, bankDate: v.bankDate || undefined, ...(v.status === 'BOUNCED' && v.bounceCharge !== undefined ? { bounceCharge: v.bounceCharge } : {}) }),
      })
      onDone()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Modal title={receipt && `Reconcile receipt #${receipt.receiptNo}`} open={!!receipt} onCancel={onClose} onOk={() => form.submit()} okText="Save">
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="status" label="Result">
          <Radio.Group>
            {receipt?.clearStatus !== 'CLEARED' && <Radio value="CLEARED">Cleared (bank credited)</Radio>}
            <Radio value="BOUNCED">Bounced / returned</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="bankDate" label="Bank date" rules={[{ required: status === 'CLEARED', message: 'Required when cleared' }]}>
          <Input type="date" min={receipt?.date.slice(0, 10)} max={today()} />
        </Form.Item>
        {status === 'BOUNCED' && (
          <Form.Item name="bounceCharge" label="Bounce charge (added to the student's bill)">
            <InputNumber min={0} precision={2} prefix="₹" style={{ width: 160 }} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}
