import { Button, Descriptions, Modal, Table, Tag, message } from 'antd'
import { openPdf } from './api'
import { inr } from './bill'

export type Receipt = {
  id: number; receiptNo: number; date: string; mode: string; reference?: string; remarks?: string; amount: string
  createdBy: string; cancelledAt?: string; cancelledBy?: string; cancelReason?: string
  student: { admissionNo: string; name: string }
  allocations: { installment: string; charges: string; fine: string }[]
}

export const modes = ['CASH', 'CHEQUE', 'UPI', 'BANK_TRANSFER', 'CARD'].map((m) => ({ value: m, label: m.replace('_', ' ') }))

export function ReceiptModal({ receipt, onClose }: { receipt: Receipt | null; onClose: () => void }) {
  return (
    <Modal title={receipt && `Receipt #${receipt.receiptNo}`} open={!!receipt} onCancel={onClose}
      footer={[<Button key="p" onClick={() => openPdf(`/payments/${receipt!.id}/pdf`).catch((e) => message.error(e.message))}>PDF</Button>, <Button key="c" type="primary" onClick={onClose}>Close</Button>]}>
      {receipt && (
        <>
          {receipt.cancelledAt && <Tag color="red">Cancelled by {receipt.cancelledBy}: {receipt.cancelReason}</Tag>}
          <Descriptions size="small" column={1} style={{ margin: '12px 0' }} items={[
            { label: 'Date', children: receipt.date.slice(0, 10) },
            { label: 'Student', children: `${receipt.student.name} (${receipt.student.admissionNo})` },
            { label: 'Mode', children: receipt.reference ? `${receipt.mode} · ${receipt.reference}` : receipt.mode },
            { label: 'Amount', children: <b>{inr(receipt.amount)}</b> },
            ...(receipt.remarks ? [{ label: 'Remarks', children: receipt.remarks }] : []),
            { label: 'Collected by', children: receipt.createdBy },
          ]} />
          <Table rowKey="installment" size="small" pagination={false} dataSource={receipt.allocations} columns={[
            { title: 'Installment', dataIndex: 'installment' },
            { title: 'Charges', dataIndex: 'charges', align: 'right', render: inr },
            { title: 'Fine', dataIndex: 'fine', align: 'right', render: inr },
          ]} />
        </>
      )}
    </Modal>
  )
}
