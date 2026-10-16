try {
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function('')
  postMessage('eval allowed')
} catch (error) {
  postMessage(error.name)
}
