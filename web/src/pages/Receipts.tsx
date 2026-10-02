import { Button, Input, Modal, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import { inr } from '../bill'
import { ReceiptModal, type Receipt } from '../receipt'

export default function Receipts() {
  const { schoolId, yearId } = useSelection()
  const [rows, setRows] = useState<Receipt[]>([])
  const [range, setRange] = useState({ from: '', to: '' })
  const [viewing, setViewing] = useState<Receipt | null>(null)
  const [cancelling, setCancelling] = useState<Receipt | null>(null)
  const [reason, setReason] = useState('')

  const load = async () => {
    if (!schoolId || !yearId) return
    const qs = new URLSearchParams({ schoolId: String(schoolId), yearId: String(yearId) })
    if (range.from) qs.set('from', range.from)
    if (range.to) qs.set('to', range.to)
    setRows(await api<Receipt[]>(`/payments?${qs}`))
  }
  useEffect(() => {
    load().catch((e) => message.error(e.message))
  }, [schoolId, yearId, range])

  async function cancel() {
    try {
      await api(`/payments/${cancelling!.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })
      setCancelling(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const live = rows.filter((r) => !r.cancelledAt)
  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        From <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        To <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        <span>{live.length} receipts · <b>{inr(String(live.reduce((s, r) => s + Number(r.amount), 0)))}</b></span>
      </Space>
      <Table rowKey="id" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'No.', dataIndex: 'receiptNo' },
        { title: 'Date', dataIndex: 'date', render: (v: string) => v.slice(0, 10) },
        { title: 'Student', render: (_, r) => `${r.student.name} (${r.student.admissionNo})` },
        { title: 'Mode', render: (_, r) => (r.reference ? `${r.mode} · ${r.reference}` : r.mode) },
        { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr },
        { title: 'Status', render: (_, r) => (r.cancelledAt ? <Tag color="red">Cancelled</Tag> : <Tag color="green">Valid</Tag>) },
        {
          title: '', render: (_, r) => (
            <Space>
              <Button size="small" onClick={() => setViewing(r)}>View</Button>
              {/* ponytail: shown to all; the API allows only ADMIN and returns 403 otherwise. */}
              {!r.cancelledAt && <Button size="small" danger onClick={() => { setReason(''); setCancelling(r) }}>Cancel</Button>}
            </Space>
          ),
        },
      ]} />
      <ReceiptModal receipt={viewing} onClose={() => setViewing(null)} />
      <Modal title={cancelling && `Cancel receipt #${cancelling.receiptNo}`} open={!!cancelling} onCancel={() => setCancelling(null)}
        onOk={cancel} okText="Cancel receipt" okButtonProps={{ danger: true, disabled: reason.trim().length < 3 }} cancelText="Back">
        <Input.TextArea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </>
  )
}
