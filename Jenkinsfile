/**
 * Jenkinsfile — TFGen full test pipeline
 *
 * Stages (run sequentially to fail fast):
 *   0. Checkout + Install dependencies
 *   1. Smoke Tests           ← gates everything; if this fails, stop.
 *   2. Unit Tests
 *   3. Integration Tests     ← needs DB + Redis + backend
 *   4. API Tests             ← needs running backend
 *   5. UI / E2E Tests        ← needs full stack (Playwright)
 *   6. Security Tests        ← OWASP checks, injection, RBAC
 *   7. Performance Tests     ← k6 load test (optional, post-merge only)
 *   8. Publish Reports       ← JUnit XML, coverage, Playwright HTML
 *
 * Required Jenkins credentials:
 *   TEST_DATABASE_URL  — postgresql://…/tfgen_test
 *   TEST_REDIS_URL     — redis://…:6379
 *   JWT_SECRET         — any strong random string (for test env)
 *   ENCRYPT_KEY        — exactly 32 printable chars (for test env)
 *
 * Required Jenkins plugins:
 *   - Pipeline
 *   - JUnit
 *   - HTML Publisher
 *   - Docker Pipeline (for service containers)
 *   - Credentials Binding
 */

pipeline {
  agent { label 'docker-node18' }   // any agent that has Docker + Node.js 18+

  options {
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timestamps()
  }

  environment {
    // ── App ports (unique to avoid conflicts with other jobs) ──────────────
    BACKEND_TEST_PORT = '4099'
    FRONTEND_URL      = 'http://localhost:3000'

    // ── Test credentials (override from Jenkins credentials store) ─────────
    TEST_DATABASE_URL = credentials('TEST_DATABASE_URL')
    TEST_REDIS_URL    = credentials('TEST_REDIS_URL')
    JWT_SECRET        = credentials('TFGEN_TEST_JWT_SECRET')
    ENCRYPT_KEY       = credentials('TFGEN_TEST_ENCRYPT_KEY')

    // ── Node / npm ─────────────────────────────────────────────────────────
    NODE_ENV          = 'test'
    CI                = 'true'
    NPM_CONFIG_CACHE  = "${WORKSPACE}/.npm-cache"

    // ── Reports ────────────────────────────────────────────────────────────
    REPORT_DIR        = "${WORKSPACE}/tests/reports"

    // ── Playwright ────────────────────────────────────────────────────────
    PLAYWRIGHT_BROWSERS_PATH = "${WORKSPACE}/.playwright-browsers"
  }

  stages {

    // ─────────────────────────────────────────────────────────────────────────
    stage('Checkout') {
      steps {
        checkout scm
        echo "Branch: ${env.BRANCH_NAME} | Build: ${env.BUILD_NUMBER}"
        sh 'node --version && npm --version'
        sh 'mkdir -p ${REPORT_DIR}'
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    stage('Install Dependencies') {
      parallel {
        stage('Backend deps') {
          steps {
            dir('backend') {
              sh 'npm ci --prefer-offline'
            }
          }
        }
        stage('Frontend deps') {
          steps {
            dir('frontend') {
              sh 'npm ci --prefer-offline'
            }
          }
        }
        stage('Test suite deps') {
          steps {
            dir('tests') {
              sh 'npm ci --prefer-offline'
            }
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    stage('Start Services') {
      steps {
        script {
          // Start Postgres + Redis as Docker containers for the test run
          sh '''
            echo "[pipeline] Starting test Postgres..."
            docker run -d --name tfgen-test-postgres-${BUILD_NUMBER} \
              -e POSTGRES_USER=tfgen \
              -e POSTGRES_PASSWORD=tfgen123 \
              -e POSTGRES_DB=tfgen_test \
              -p 5433:5432 \
              --health-cmd="pg_isready -U tfgen -d tfgen_test" \
              --health-interval=3s --health-retries=10 \
              postgres:15-alpine || true

            echo "[pipeline] Starting test Redis..."
            docker run -d --name tfgen-test-redis-${BUILD_NUMBER} \
              -p 6380:6379 \
              redis:7-alpine || true

            echo "[pipeline] Waiting for DB to be healthy..."
            for i in $(seq 1 20); do
              docker exec tfgen-test-postgres-${BUILD_NUMBER} \
                pg_isready -U tfgen -d tfgen_test && break || sleep 3
            done

            echo "[pipeline] Running DB migrations on test DB..."
            PGPASSWORD=tfgen123 psql -h 127.0.0.1 -p 5433 -U tfgen -d tfgen_test \
              -f database/migrate.sql || true
          '''

          // Override env for the test DB/Redis ports
          env.TEST_DATABASE_URL = 'postgresql://tfgen:tfgen123@127.0.0.1:5433/tfgen_test'
          env.TEST_REDIS_URL    = 'redis://127.0.0.1:6380'
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    stage('Start Backend Server') {
      steps {
        dir('backend') {
          sh '''
            PORT=${BACKEND_TEST_PORT} \
            DATABASE_URL=${TEST_DATABASE_URL} \
            REDIS_URL=${TEST_REDIS_URL} \
            JWT_SECRET=${JWT_SECRET} \
            JWT_REFRESH_SECRET=${JWT_SECRET}-refresh \
            ENCRYPT_KEY=${ENCRYPT_KEY} \
            SKIP_STS_VERIFY=true \
            SKIP_DOCKER=true \
            NODE_ENV=test \
            node server.js &
            echo $! > ${WORKSPACE}/backend-test.pid

            echo "[pipeline] Waiting for backend to become ready..."
            for i in $(seq 1 30); do
              curl -sf http://localhost:${BACKEND_TEST_PORT}/api/health && break || sleep 2
            done
            echo "[pipeline] Backend is ready on port ${BACKEND_TEST_PORT}"
          '''
        }
        // Set env for test suites
        script {
          env.TEST_BASE_URL         = "http://localhost:${env.BACKEND_TEST_PORT}"
          env.TEST_PORT             = env.BACKEND_TEST_PORT
          env.TEST_SKIP_SERVER_START = 'true'
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 1: SMOKE TESTS — must pass before any other stage runs
    // ═════════════════════════════════════════════════════════════════════════
    stage('Smoke Tests') {
      steps {
        dir('tests') {
          sh '''
            NODE_ENV=test \
            TEST_BASE_URL=${TEST_BASE_URL} \
            FRONTEND_URL=${FRONTEND_URL} \
            node_modules/.bin/jest \
              --config jest.smoke.config.js \
              --forceExit \
              --ci \
              --reporters=default \
              --reporters=jest-junit \
              --testResultsProcessor=jest-junit \
              2>&1 | tee ${REPORT_DIR}/smoke-output.log
          '''
        }
      }
      post {
        always {
          junit testResults: 'tests/reports/junit-results.xml', allowEmptyResults: true
        }
        failure {
          error('🔴 Smoke tests FAILED — aborting pipeline. Fix the deployment first.')
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 2: UNIT TESTS
    // ═════════════════════════════════════════════════════════════════════════
    stage('Unit Tests') {
      steps {
        dir('tests') {
          sh '''
            NODE_ENV=test \
            JWT_SECRET=${JWT_SECRET} \
            ENCRYPT_KEY=${ENCRYPT_KEY} \
            node_modules/.bin/jest \
              --config jest.unit.config.js \
              --forceExit \
              --ci \
              --coverage \
              --coverageDirectory=${REPORT_DIR}/coverage \
              --reporters=default \
              --reporters=jest-junit \
              2>&1 | tee ${REPORT_DIR}/unit-output.log
          '''
        }
      }
      post {
        always {
          junit testResults: 'tests/reports/junit-results.xml', allowEmptyResults: true
          publishHTML(target: [
            allowMissing:           true,
            alwaysLinkToLastBuild:  true,
            keepAll:                true,
            reportDir:              'tests/reports/coverage/lcov-report',
            reportFiles:            'index.html',
            reportName:             'Unit Test Coverage',
          ])
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 3: INTEGRATION TESTS
    // ═════════════════════════════════════════════════════════════════════════
    stage('Integration Tests') {
      steps {
        dir('tests') {
          sh '''
            NODE_ENV=test \
            TEST_BASE_URL=${TEST_BASE_URL} \
            TEST_DATABASE_URL=${TEST_DATABASE_URL} \
            TEST_REDIS_URL=${TEST_REDIS_URL} \
            JWT_SECRET=${JWT_SECRET} \
            ENCRYPT_KEY=${ENCRYPT_KEY} \
            TEST_SKIP_SERVER_START=true \
            node_modules/.bin/jest \
              --config jest.integration.config.js \
              --forceExit \
              --runInBand \
              --ci \
              --reporters=default \
              --reporters=jest-junit \
              2>&1 | tee ${REPORT_DIR}/integration-output.log
          '''
        }
      }
      post {
        always {
          junit testResults: 'tests/reports/junit-results.xml', allowEmptyResults: true
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 4: API TESTS
    // ═════════════════════════════════════════════════════════════════════════
    stage('API Tests') {
      steps {
        dir('tests') {
          sh '''
            NODE_ENV=test \
            TEST_BASE_URL=${TEST_BASE_URL} \
            TEST_DATABASE_URL=${TEST_DATABASE_URL} \
            JWT_SECRET=${JWT_SECRET} \
            ENCRYPT_KEY=${ENCRYPT_KEY} \
            TEST_SKIP_SERVER_START=true \
            node_modules/.bin/jest \
              --config jest.api.config.js \
              --forceExit \
              --runInBand \
              --ci \
              --reporters=default \
              --reporters=jest-junit \
              2>&1 | tee ${REPORT_DIR}/api-output.log
          '''
        }
      }
      post {
        always {
          junit testResults: 'tests/reports/junit-results.xml', allowEmptyResults: true
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 5: UI / E2E TESTS (Playwright)
    // ═════════════════════════════════════════════════════════════════════════
    stage('UI / E2E Tests') {
      when {
        // Run E2E only when the frontend is actually deployed (env var set)
        expression { return env.RUN_E2E != 'false' }
      }
      steps {
        dir('tests') {
          sh '''
            # Install Playwright browsers (cached by PLAYWRIGHT_BROWSERS_PATH)
            PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH} \
              node_modules/.bin/playwright install --with-deps chromium firefox

            # Run E2E tests
            FRONTEND_URL=${FRONTEND_URL} \
            TEST_BASE_URL=${TEST_BASE_URL} \
            PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH} \
            node_modules/.bin/playwright test \
              --config e2e/playwright.config.js \
              --reporter=list,junit,html \
              2>&1 | tee ${REPORT_DIR}/e2e-output.log

            # Copy Playwright JUnit output
            cp playwright-report/*.xml ${REPORT_DIR}/e2e-junit.xml 2>/dev/null || true
          '''
        }
      }
      post {
        always {
          junit testResults: 'tests/reports/e2e-junit.xml', allowEmptyResults: true
          publishHTML(target: [
            allowMissing:           true,
            alwaysLinkToLastBuild:  true,
            keepAll:                true,
            reportDir:              'tests/reports/playwright-report',
            reportFiles:            'index.html',
            reportName:             'Playwright E2E Report',
          ])
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 6: SECURITY TESTS
    // ═════════════════════════════════════════════════════════════════════════
    stage('Security Tests') {
      steps {
        dir('tests') {
          sh '''
            NODE_ENV=test \
            TEST_BASE_URL=${TEST_BASE_URL} \
            JWT_SECRET=${JWT_SECRET} \
            ENCRYPT_KEY=${ENCRYPT_KEY} \
            TEST_SKIP_SERVER_START=true \
            node_modules/.bin/jest \
              --config jest.security.config.js \
              --forceExit \
              --runInBand \
              --ci \
              --reporters=default \
              --reporters=jest-junit \
              2>&1 | tee ${REPORT_DIR}/security-output.log
          '''
        }
      }
      post {
        always {
          junit testResults: 'tests/reports/junit-results.xml', allowEmptyResults: true
        }
        failure {
          echo '🔴 Security tests failed — review OWASP findings in the log above.'
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 7: PERFORMANCE TESTS (k6) — main / release branches only
    // ═════════════════════════════════════════════════════════════════════════
    stage('Performance Tests') {
      when {
        anyOf {
          branch 'main'
          branch 'release/*'
          environment name: 'RUN_PERF', value: 'true'
        }
      }
      steps {
        sh '''
          which k6 || (echo "[pipeline] k6 not found — installing..." && \
            curl -s https://github.com/grafana/k6/releases/download/v0.50.0/k6-v0.50.0-linux-amd64.tar.gz \
            | tar -xz --strip-components=1 -C /usr/local/bin/ k6-v0.50.0-linux-amd64/k6)

          # Register a dedicated performance test user
          curl -s -X POST ${TEST_BASE_URL}/api/auth/register \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"perf@tfgen-test.local\",\"password\":\"Perf@12345!\"}" || true

          echo "[pipeline] Running k6 load test..."
          k6 run tests/performance/k6-load.js \
            -e BASE_URL=${TEST_BASE_URL} \
            -e TEST_USER=perf@tfgen-test.local \
            -e TEST_PASS="Perf@12345!" \
            --out json=${REPORT_DIR}/k6-results.json \
            --summary-export=${REPORT_DIR}/k6-summary.json \
            2>&1 | tee ${REPORT_DIR}/k6-output.log
        '''
      }
      post {
        always {
          // Archive k6 results as artifacts
          archiveArtifacts artifacts: 'tests/reports/k6-*.json,tests/reports/k6-output.log',
                           allowEmptyArchive: true
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 8: BUILD DOCKER IMAGES (optional, on main only)
    // ═════════════════════════════════════════════════════════════════════════
    stage('Build & Verify Docker Images') {
      when {
        branch 'main'
      }
      steps {
        sh '''
          echo "[pipeline] Building backend image..."
          docker build -t tfgen-backend:test-${BUILD_NUMBER} ./backend

          echo "[pipeline] Building frontend image..."
          docker build -t tfgen-frontend:test-${BUILD_NUMBER} ./frontend

          echo "[pipeline] Verifying backend container starts..."
          docker run --rm -d --name tfgen-verify-backend-${BUILD_NUMBER} \
            -e NODE_ENV=test \
            -e PORT=4099 \
            -e DATABASE_URL=${TEST_DATABASE_URL} \
            -e REDIS_URL=${TEST_REDIS_URL} \
            -e JWT_SECRET=${JWT_SECRET} \
            -e ENCRYPT_KEY=${ENCRYPT_KEY} \
            -e SKIP_STS_VERIFY=true \
            -p 4098:4099 \
            tfgen-backend:test-${BUILD_NUMBER}

          sleep 5
          curl -sf http://localhost:4098/api/health || \
            (docker logs tfgen-verify-backend-${BUILD_NUMBER} && exit 1)

          docker stop tfgen-verify-backend-${BUILD_NUMBER} || true
        '''
      }
      post {
        always {
          sh '''
            docker stop tfgen-verify-backend-${BUILD_NUMBER} 2>/dev/null || true
            docker rmi tfgen-backend:test-${BUILD_NUMBER} 2>/dev/null || true
            docker rmi tfgen-frontend:test-${BUILD_NUMBER} 2>/dev/null || true
          '''
        }
      }
    }

  } // end stages

  // ─── Post pipeline ──────────────────────────────────────────────────────────
  post {
    always {
      // Kill test backend server
      sh '''
        if [ -f ${WORKSPACE}/backend-test.pid ]; then
          kill $(cat ${WORKSPACE}/backend-test.pid) 2>/dev/null || true
          rm -f ${WORKSPACE}/backend-test.pid
        fi
      '''

      // Tear down Docker test containers
      sh '''
        docker stop  tfgen-test-postgres-${BUILD_NUMBER} 2>/dev/null || true
        docker stop  tfgen-test-redis-${BUILD_NUMBER}    2>/dev/null || true
        docker rm -f tfgen-test-postgres-${BUILD_NUMBER} 2>/dev/null || true
        docker rm -f tfgen-test-redis-${BUILD_NUMBER}    2>/dev/null || true
      '''

      // Archive all test logs and reports
      archiveArtifacts artifacts: 'tests/reports/**/*', allowEmptyArchive: true

      // Publish consolidated JUnit results
      junit testResults: 'tests/reports/junit-results.xml', allowEmptyResults: true

      // Cleanup workspace (keep reports for 30 days)
      cleanWs(
        deleteDirs:             true,
        disableDeferredWipeout: true,
        notFailBuild:           true,
        patterns: [
          [pattern: 'tests/reports/**', type: 'EXCLUDE'],
        ]
      )
    }

    success {
      echo '✅ All test stages passed successfully!'
      // Optionally notify Slack/Teams/email here
    }

    failure {
      echo '❌ Pipeline FAILED — check stage logs above for details.'
      // emailext body: '...', subject: 'BUILD FAILED', to: '...'
    }

    unstable {
      echo '⚠️ Pipeline UNSTABLE — some tests failed. Review JUnit reports.'
    }
  }
}
