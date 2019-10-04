import MockAdapter from 'axios-mock-adapter'
import jwt from 'jsonwebtoken'
import each from 'jest-each'
import hash from 'object-hash'
import faker from 'faker'
import { SampleHandler, jobInfo, main } from '../mocks/sample/sample-handler'
import * as mockCloudwatchScheduledEvent from '../mocks/events/cloudwatch-scheduled-event.json'
import * as mockLambdaReinvokeEvent from '../mocks/events/lambda-reinvoke-event.json'
import mockRequest from '../mocks/sample/request'
import mockResponse from '../mocks/sample/response'
import sampleAxios from '../mocks/sample/sample-lib-axios'
import msaAxios from '../lib/mpp-sql-adapter-axios'
import helper from '../lib/helper'

jest.mock('../lib/helper')

describe('[' + jobInfo.id + '] ' + jobInfo.name, () => {
  const testCases = [
    ['aws.events', mockCloudwatchScheduledEvent],
    ['aws.lambda', mockLambdaReinvokeEvent]
  ]
  const mockMsaAccessToken = jwt.sign({ userId: 1 }, 'secret', { expiresIn: '30d' })
  const mockMsaLAxios = new MockAdapter(msaAxios)
  const mockSampleAxios = new MockAdapter(sampleAxios)
  const mockJobContext = {
    functionName: 'test-sample-job',
    localData: {
      jobInfo: jobInfo
    }
  }

  beforeAll(() => {
    jest.resetModules()
    helper._set_mock_client_credentials()
    helper._set_mock_access_token(mockMsaAccessToken)
    mockLambdaReinvokeEvent.payload = JSON.stringify(mockRequest)
    mockLambdaReinvokeEvent.md5Payload = hash.MD5(mockLambdaReinvokeEvent.payload)
    mockLambdaReinvokeEvent.retries = 1
    mockLambdaReinvokeEvent.receiptHandle = faker.random.uuid()
  })

  afterAll(() => {
    helper._aws_mock_restore()
  })

  beforeEach(() => {
    mockMsaLAxios.onPost('/queries').reply(200, mockRequest)
  })

  afterEach(() => {
    jest.clearAllMocks()
    mockSampleAxios.reset()
    mockMsaLAxios.reset()
  })

  describe('All Test Cases', () => {
    each(testCases).test('%s - mpp adapter should return list of users with format', async (source, mockEvent) => {
      const handler = new SampleHandler(mockEvent, mockJobContext)
      const data = await handler.getJobData()
      expect(data).toEqual(mockRequest)
    })

    each(testCases).test('%s - should have proper data and format for client custom api', async (source, mockEvent) => {
      mockSampleAxios.onPost('/sample-api').reply(config => {
        if (config.headers['Content-Type'] === 'application/json') {
          const jsonData = JSON.parse(config.data)
          if (jsonData.id && jsonData.sample_data) {
            return [200, mockResponse.success]
          }
        }
        return [400, mockResponse.fail]
      })
      const handler = new SampleHandler(mockEvent, mockJobContext)
      await Promise.all(mockRequest.map(async (mockSampleData) => {
        const { status, data } = await handler.customSampleJob(mockSampleData)
        expect(status).toEqual(200)
        expect(data.result).toBeTruthy()
      }))
    })

    each(testCases).test('%s - should be able to send email notifications for errors upon MPP query', async (source, mockEvent) => {
      mockMsaLAxios.onPost('/queries').networkError()
      const localEvent = { ...mockEvent }
      if (source === 'aws.lambda') {
        localEvent.payload = ''
      }
      const handler = new SampleHandler(localEvent, mockJobContext)
      const callback = (error, result) => {
        expect(error).toBeTruthy()
        expect(helper.notify_on_error).toHaveBeenCalledTimes(1)
        if (handler.isReinvoked()) {
          expect(helper.release_failed_job).toHaveBeenCalledTimes(1)
          expect(helper.release_failed_job).toHaveBeenCalledWith(localEvent.receiptHandle)
        }
      }
      await handler.main(callback)
    })
  })

  describe('Test Case: aws.events', () => {
    test('should be able to execute all successfully from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(0)
        expect(result.notify).toHaveLength(0)
        expect(result.success).toHaveLength(mockRequest.length)
        result.success.map(suc => {
          expect(suc).toHaveProperty('data')
          expect(suc).toHaveProperty('result')
        })
      }
      mockSampleAxios.onPost('/sample-api').reply(200, mockResponse.success)
      await main(mockCloudwatchScheduledEvent, mockJobContext, callback)
    })

    test('should be able to enqueue failed job data from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(mockRequest.length)
        expect(result.success).toHaveLength(0)
        expect(result.notify).toHaveLength(0)
        result.fail.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.enqueue_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.enqueue_failed_job).toHaveBeenCalledWith(
          result.fail,
          mockJobContext.functionName
        )
      }
      mockSampleAxios.onPost('/sample-api').reply(200, mockResponse.fail)
      await main(mockCloudwatchScheduledEvent, mockJobContext, callback)
    })

    test('should be able to enqueue network errors from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(mockRequest.length)
        expect(result.success).toHaveLength(0)
        expect(result.notify).toHaveLength(0)
        result.fail.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.enqueue_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.enqueue_failed_job).toHaveBeenCalledWith(
          result.fail,
          mockJobContext.functionName
        )
      }
      mockSampleAxios.onPost('/sample-api').networkError()
      await main(mockCloudwatchScheduledEvent, mockJobContext, callback)
    })

    test('should be able to send email notifications for invalid client data from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(0)
        expect(result.success).toHaveLength(0)
        expect(result.notify).toHaveLength(mockRequest.length)
        result.notify.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.notify_on_failed_queue).toHaveBeenCalledTimes(1)
        expect(helper.enqueue_failed_job).not.toHaveBeenCalled()
      }
      mockSampleAxios.onPost('/sample-api').reply(400, {})
      await main(mockCloudwatchScheduledEvent, mockJobContext, callback)
    })
  })

  describe('Test Case: aws.lambda (Re-Invoke)', () => {
    test('should be able to execute all successfully from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(0)
        expect(result.notify).toHaveLength(0)
        expect(result.success).toHaveLength(mockRequest.length)
        result.success.map(suc => {
          expect(suc).toHaveProperty('data')
          expect(suc).toHaveProperty('result')
        })
        expect(helper.delete_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.delete_failed_job).toHaveBeenCalledWith(
          mockLambdaReinvokeEvent.receiptHandle
        )
      }
      mockSampleAxios.onPost('/sample-api').reply(200, mockResponse.success)
      await main(mockLambdaReinvokeEvent, mockJobContext, callback)
    })

    test('should be able to re-enqueue failed job data from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(mockRequest.length)
        expect(result.success).toHaveLength(0)
        expect(result.notify).toHaveLength(0)
        result.fail.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.release_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.release_failed_job).toHaveBeenCalledWith(
          mockLambdaReinvokeEvent.receiptHandle
        )
      }
      mockSampleAxios.onPost('/sample-api').reply(200, mockResponse.fail)
      await main(mockLambdaReinvokeEvent, mockJobContext, callback)
    })

    test('should be able to re-enqueue network errors from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.fail).toHaveLength(mockRequest.length)
        expect(result.success).toHaveLength(0)
        expect(result.notify).toHaveLength(0)
        result.fail.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.release_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.release_failed_job).toHaveBeenCalledWith(
          mockLambdaReinvokeEvent.receiptHandle
        )
      }
      mockSampleAxios.onPost('/sample-api').networkError()
      await main(mockLambdaReinvokeEvent, mockJobContext, callback)
    })

    test('should be able to re-enqueue partially failed job data from main', async () => {
      const failMax = 1
      let failCount = 0
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.notify).toHaveLength(0)
        expect(result.fail).toHaveLength(failCount)
        expect(result.success).toHaveLength(mockRequest.length - failCount)
        result.fail.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.delete_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.delete_failed_job).toHaveBeenCalledWith(
          mockLambdaReinvokeEvent.receiptHandle
        )
        expect(helper.enqueue_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.enqueue_failed_job).toHaveBeenCalledWith(
          result.fail,
          mockJobContext.functionName
        )
      }
      mockSampleAxios.onPost('/sample-api').reply(() => {
        if (failCount < failMax) {
          failCount++
          return [200, mockResponse.fail]
        }
        return [200, mockResponse.success]
      })
      await main(mockLambdaReinvokeEvent, mockJobContext, callback)
    })

    test('should be able to send email notifications for invalid client data from main', async () => {
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result).toHaveProperty('notify')
        expect(result.notify).toHaveLength(mockRequest.length)
        expect(result.fail).toHaveLength(0)
        expect(result.success).toHaveLength(0)
        result.notify.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.notify_on_failed_queue).toHaveBeenCalledTimes(1)
        expect(helper.release_failed_job).not.toHaveBeenCalled()
        expect(helper.delete_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.delete_failed_job).toHaveBeenCalledWith(
          mockLambdaReinvokeEvent.receiptHandle
        )
      }
      mockSampleAxios.onPost('/sample-api').reply(400, {})
      await main(mockLambdaReinvokeEvent, mockJobContext, callback)
    })

    test('should be able to send email notifications for failed job data that exceed retries threshold from main', async () => {
      const localEvent = { ...mockLambdaReinvokeEvent, ...{ retries: process.env.DEFAULT_NOTIFY_RETRIES_THRESHOLD } }
      const callback = (error, result) => {
        expect(error).toBeNull()
        expect(result).toHaveProperty('fail')
        expect(result).toHaveProperty('success')
        expect(result.fail).toHaveLength(mockRequest.length)
        expect(result.success).toHaveLength(0)
        result.fail.map(failure => {
          expect(failure).toHaveProperty('data')
          expect(failure).toHaveProperty('error')
        })
        expect(helper.notify_on_failed_queue).toHaveBeenCalledTimes(1)
        expect(helper.notify_on_failed_queue).toHaveBeenCalled()
        expect(helper.release_failed_job).toHaveBeenCalledTimes(1)
        expect(helper.release_failed_job).toHaveBeenCalledWith(
          mockLambdaReinvokeEvent.receiptHandle
        )
      }
      mockSampleAxios.onPost('/sample-api').reply(200, mockResponse.fail)
      await main(localEvent, mockJobContext, callback)
    })
  })
})
