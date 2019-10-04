import AWS from 'aws-sdk'
import jwtDecode from 'jwt-decode'

const ssm = new AWS.SSM({ apiVersion: '2014-11-06' })
const sns = new AWS.SNS({ apiVersion: '2010-03-31' })
const sqs = new AWS.SQS({ apiVersion: '2012-11-05' })

const helper = {}

helper.get_ssm_param = (params) => {
  if (typeof params === 'string') {
    params = {
      Name: params
    }
  }
  params = {
    ...params,
    ...{
      Name: process.env.SSM_PARAM_NS + '/' + params.Name
    }
  }
  return ssm.getParameter(params).promise()
}

helper.put_ssm_param = (params) => {
  params = {
    ...{
      Type: 'String',
      Overwrite: true
    },
    ...params,
    ...{
      Name: process.env.SSM_PARAM_NS + '/' + params.Name
    }
  }
  return ssm.putParameter(params).promise()
}

helper.publish_sns_message = (params, client = false) => {
  params = {
    ...{
      TopicArn: process.env.SNS_TOPIC_ARN,
      MessageStructure: 'json'
    },
    ...params
  }
  if (!client) {
    params.TopicArn = process.env.SNS_INTERNAL_TOPIC_ARN
  }
  if (typeof params.Message !== 'string' && params.MessageStructure === 'json') {
    params.Message = JSON.stringify(params.Message)
  }
  return sns.publish(params).promise()
}

helper.compose_sns_failure_message = (failedRun) => {
  let subject = failedRun.job.name
  const message = {}
  if (failedRun.hasOwnProperty('error') && failedRun.error) {
    subject = 'Encountered error on job: ' + subject
    if (failedRun.error.message) {
      message.sms = failedRun.error.message
    } else {
      message.sms = failedRun.error.toString()
    }
    message.email = message.default = failedRun.error.toString()
  } else if (failedRun.hasOwnProperty('queue') && failedRun.queue && failedRun.queue.length) {
    subject = 'Failed runs on job: ' + subject
    const header = failedRun.queue.length + ' failed.'
    message.sms = header
    let failedRunsMessage = ''
    failedRun.queue.map((failed) => {
      failedRunsMessage += 'Request: \n'
      failedRunsMessage += JSON.stringify(failed.data, null, 2) + '\n'
      if (Boolean(failed.error.message) && failed.error.message.length) {
        failedRunsMessage += 'Error: ' + failed.error.message
      } else {
        failedRunsMessage += 'Error: ' + failed.error.toString()
      }
      failedRunsMessage += '\n-------\n'
    })
    message.default = message.email = header + '\n-------\n' + failedRunsMessage
  } else {
    return false
  }
  return {
    Message: message,
    Subject: subject
  }
}

helper.notify_on_error = (jobError) => {
  const subject = 'Encountered error on job: ' + jobError.job.name
  const message = {}
  let messageText = ''
  if (process.env.MPP_CLIENT_NAME) {
    messageText += 'CLIENT: ' + process.env.MPP_CLIENT_NAME
    if (process.env.MPP_CLIENT_APP_ID) {
      messageText += ' (' + process.env.MPP_CLIENT_APP_ID + ')'
    }
    messageText += '\n-------\n'
  }
  messageText += 'JOB: ' + JSON.stringify(jobError.job, null, 2)
  messageText += '\n-------\n'
  if (jobError.hasOwnProperty('currentData') && jobError.currentData) {
    messageText += 'REQUEST: ' + JSON.stringify(jobError.currentData, null, 2)
    messageText += '\n-------\n'
  }
  messageText += 'EVENT: ' + JSON.stringify(jobError.event, null, 2)
  messageText += '\n-------\n'
  if (Boolean(jobError.error.message) && Boolean(jobError.error.response) && Boolean(jobError.error.response.data)) {
    message.sms = jobError.error.message
    messageText += 'ERROR: ' + jobError.error.message + '\n' + JSON.stringify(jobError.error.response.data, null, 2)
  } else if (Boolean(jobError.error.message) && jobError.error.message.length) {
    message.sms = jobError.error.message
    messageText += 'ERROR: ' + jobError.error.message
  } else {
    message.sms = 'Error on: ' + jobError.job.id
    if (jobError instanceof Error) {
      messageText += 'ERROR: ' + JSON.stringify(jobError, Object.getOwnPropertyNames(jobError), 2)
    } else {
      messageText += 'ERROR: ' + JSON.stringify(jobError.error, null, 2)
    }
  }
  message.email = message.default = messageText
  return helper.publish_sns_message({
    Message: message,
    Subject: subject
  }, false)
}

helper.notify_on_failed_queue = async (jobError) => {
  const subject = 'Failed runs on job: ' + jobError.job.name
  const header = jobError.queue.length + ' failed.'
  let jobErrorsMessage = ''
  if (process.env.MPP_CLIENT_NAME) {
    jobErrorsMessage += 'CLIENT: ' + process.env.MPP_CLIENT_NAME
    if (process.env.MPP_CLIENT_APP_ID) {
      jobErrorsMessage += ' (' + process.env.MPP_CLIENT_APP_ID + ')'
    }
    jobErrorsMessage += '\n-------\n'
  }
  jobErrorsMessage += 'JOB: ' + JSON.stringify(jobError.job, null, 2)
  jobErrorsMessage += '\n-------\n'
  jobError.queue.map((job) => {
    jobErrorsMessage += 'REQUEST: \n'
    jobErrorsMessage += JSON.stringify(job.data, null, 2) + '\n'
    if (job.error.message) {
      jobErrorsMessage += 'ERROR: ' + job.error.message
      if (job.error.response && job.error.response.data) {
        jobErrorsMessage += '\n' + JSON.stringify(job.error.response.data, null, 2)
      }
    } else {
      jobErrorsMessage += 'ERROR: ' + job.error.toString()
    }
    jobErrorsMessage += '\n-------\n'
  })
  jobErrorsMessage += 'EVENT: ' + JSON.stringify(jobError.event, null, 2)
  jobErrorsMessage += '\n-------\n'
  return helper.publish_sns_message({
    Message: {
      default: header + '\n-------\n' + jobErrorsMessage,
      email: header + '\n-------\n' + jobErrorsMessage,
      sms: header
    },
    Subject: subject
  }, true)
}

helper.get_failed_jobs_as_string = (failedJobs) => {
  return JSON.stringify(failedJobs.map(job => job.data))
}

helper.enqueue_failed_job = (failedJobs, functionName) => {
  failedJobs = helper.get_failed_jobs_as_string(failedJobs)
  const params = {
    QueueUrl: process.env.SQS_FAILED_QUEUE_URL,
    DelaySeconds: 60,
    MessageBody: failedJobs,
    MessageAttributes: {
      'FunctionName': {
        DataType: 'String',
        StringValue: functionName
      }
    }
  }
  return sqs.sendMessage(params).promise()
}

helper.enqueue_current_job_data = (jobData, error, functionName) => {
  const failedQueue = []
  jobData.map(job => {
    failedQueue.push({ data: job, error: error })
  })
  return helper.enqueue_failed_job(failedQueue, functionName)
}

helper.delete_failed_job = (handle) => {
  const params = {
    QueueUrl: process.env.SQS_FAILED_QUEUE_URL,
    ReceiptHandle: handle
  }
  return sqs.deleteMessage(params).promise()
}

helper.release_failed_job = (handle) => {
  const params = {
    QueueUrl: process.env.SQS_FAILED_QUEUE_URL,
    ReceiptHandle: handle,
    VisibilityTimeout: 60
  }
  return sqs.changeMessageVisibility(params).promise()
}

helper.check_jwt_exp = (jwt) => {
  const decoded = jwtDecode(jwt)
  const current = Math.round(+new Date() / 1000)
  return (!decoded.hasOwnProperty('exp') || !decoded.exp) || (decoded.hasOwnProperty('exp') && decoded.exp > current)
}

export default helper
