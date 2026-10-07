import { Descriptions, Table, Typography } from 'antd'

export type Bill = {
  student: { admissionNo: string; name: string; className: string }
  installments: { installmentId: number; label: string; dueDate: string; lines: { feeHeadId: number; name: string; amount: string }[]; charges: string; fine: string; fineDays: number; paid: string; due: string }[]
  arrear?: { amount: string; paid: string; due: string; excess: string }
  totals: { charges: string; fine: string; paid: string; due: string }
}

export const inr = (v: string) => Number(v).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })

// Bill header + installment table; used by the Students drawer and Collect Fee.
export function BillView({ bill }: { bill: Bill }) {
  return (
    <>
      <Descriptions size="small" column={1} style={{ marginBottom: 16 }} items={[
        { label: 'Student', children: `${bill.student.name} (${bill.student.admissionNo})` },
        { label: 'Class', children: bill.student.className },
        // Previous-year balance: already folded into the totals below; negative amount = credit.
        ...(bill.arrear && Number(bill.arrear.amount) !== 0
          ? [{ label: 'Previous arrear', children: Number(bill.arrear.amount) > 0
              ? `${inr(bill.arrear.amount)} · paid ${inr(bill.arrear.paid)} · due ${inr(bill.arrear.due)}`
              : `Credit ${inr(String(-Number(bill.arrear.amount)))} (reduces the first installments)` }]
          : []),
      ]} />
      <Table rowKey="installmentId" dataSource={bill.installments} pagination={false} size="small" scroll={{ x: true }}
        expandable={{
          expandedRowRender: (i) => (
            <Table rowKey="name" size="small" pagination={false} dataSource={i.lines} showHeader={false} columns={[
              { dataIndex: 'name' },
              { dataIndex: 'amount', align: 'right', render: inr },
            ]} />
          ),
        }}
        columns={[
          { title: 'Installment', dataIndex: 'label' },
          { title: 'Due', dataIndex: 'dueDate', render: (v: string) => v.slice(0, 10) },
          { title: 'Charges', dataIndex: 'charges', align: 'right', render: inr },
          { title: 'Fine', dataIndex: 'fine', align: 'right', render: (v: string, r) => (r.fineDays ? `${inr(v)} (${r.fineDays}d)` : inr(v)) },
          { title: 'Paid', dataIndex: 'paid', align: 'right', render: inr },
          { title: 'Balance', dataIndex: 'due', align: 'right', render: (v: string) => <Typography.Text strong>{inr(v)}</Typography.Text> },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={3}><Typography.Text strong>Total</Typography.Text></Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right">{inr(bill.totals.charges)}</Table.Summary.Cell>
            <Table.Summary.Cell index={4} align="right">{inr(bill.totals.fine)}</Table.Summary.Cell>
            <Table.Summary.Cell index={5} align="right">{inr(bill.totals.paid)}</Table.Summary.Cell>
            <Table.Summary.Cell index={6} align="right"><Typography.Text strong>{inr(bill.totals.due)}</Typography.Text></Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
    </>
  )
}
