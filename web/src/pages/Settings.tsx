import { Alert, Button, Input, Switch, Table, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Values = { receiptFooter: string; smsEnabled: boolean; lateFeeEnabled: boolean }

// `live` = something on the server actually reads the value today.
const ROWS: { key: keyof Values; label: string; live: boolean }[] = [
  { key: 'smsEnabled', label: 'SMS enabled (off = /sms/send refuses)', live: true },
  { key: 'receiptFooter', label: 'Receipt footer (max 200 characters)', live: false },
  { key: 'lateFeeEnabled', label: 'Late fee enabled', live: false },
]

// ponytail: the UI does not know the user's role; the API returns 403 for non-admins and we show it.
export default function Settings() {
  const { schoolId } = useSelection()
  const [vals, setVals] = useState<Values>()
  const [footer, setFooter] = useState('')

  const load = () => {
    if (!schoolId) return
    api<Values>(`/settings?schoolId=${schoolId}`)
      .then((v) => (setVals(v), setFooter(v.receiptFooter)))
      .catch((e) => message.error(e.message))
  }
  useEffect(load, [schoolId])

  async function save(key: keyof Values, value: string | boolean) {
    try {
      await api(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ schoolId, value }) })
      message.success('Saved')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Per-school settings. Only admins can change them. Settings marked 'not applied yet' are stored but nothing reads them yet." />
      <Table rowKey="key" pagination={false} loading={!vals} dataSource={vals ? ROWS : []} columns={[
        { title: 'Setting', dataIndex: 'label' },
        { title: 'Applied', dataIndex: 'live', render: (v) => (v ? 'yes' : <Typography.Text type="secondary">not applied yet</Typography.Text>) },
        { title: 'Value', render: (_, r) => r.key === 'receiptFooter'
          ? <Input.Search value={footer} maxLength={200} onChange={(e) => setFooter(e.target.value)} enterButton="Save" onSearch={(v) => save('receiptFooter', v)} />
          : <Switch checked={vals?.[r.key] as boolean} onChange={(v) => save(r.key, v)} /> },
      ]} />
      <Button style={{ marginTop: 12 }} onClick={load}>Reload</Button>
    </>
  )
}
