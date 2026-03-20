pipeline {
    agent any

    stages {
        stage('Deploy') {
            steps {
                withCredentials([string(credentialsId: 'server-ip', variable: 'SERVER_IP')]) {
                    sshagent(['prod-ssh-key']) {
                        sh '''
                        ssh -o StrictHostKeyChecking=no ubuntu@$SERVER_IP "
                            cd /home/ubuntu/app/XCDN &&

                            echo '[+] Deploying...' &&

                            git fetch origin &&
                            git reset --hard origin/main &&

                            docker compose down &&
                            docker compose up -d --build &&

                            echo '[+] Deployment complete'
                        "
                        '''
                    }
                }
            }
        }
    }
}